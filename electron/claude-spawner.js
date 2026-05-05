// Spawns a real `claude -p` subprocess and streams events back to the caller.
//
// Usage:
//   const handle = spawnClaudeRequest({
//     cwd: "/some/dir",
//     prompt: "hi",
//     onEvent: (event) => { ... },  // normalized events: text / tool_use / done
//     onDone:  () => { ... },       // called once on clean exit
//     onError: (msg) => { ... },    // called once on failure
//   });
//   handle.cancel();  // SIGTERM the child and stop emitting
//
// The `claude` CLI emits line-delimited JSON when invoked with
// `--output-format stream-json --verbose`. We parse one object per line and
// map the event types we care about into the caller-facing shape.
//
// macOS only for now — guarded at the top.

const { spawn } = require("child_process");

// Inactivity timeout — reset on every stdout chunk. Means long-running
// refactors aren't killed mid-flight as long as Claude is still emitting
// something (text deltas, tool_use events). If the subprocess goes completely
// silent for this long, we give up.
const INACTIVITY_TIMEOUT_MS = 90_000;
// Absolute hard ceiling regardless of activity — prevents runaway jobs from
// eating resources forever.
const HARD_TIMEOUT_MS = 10 * 60_000;

function spawnClaudeRequest({ cwd, prompt, onEvent, onDone, onError }) {
  if (process.platform !== "darwin") {
    safeCall(onError, "Unsupported platform");
    return { cancel() {} };
  }

  let done = false;
  let sawResult = false;
  let killed = false;
  let child;
  let stderrBuf = "";
  let stdoutCarry = "";
  let inactivityHandle = null;
  let hardHandle = null;

  function clearTimers() {
    if (inactivityHandle) {
      clearTimeout(inactivityHandle);
      inactivityHandle = null;
    }
    if (hardHandle) {
      clearTimeout(hardHandle);
      hardHandle = null;
    }
  }

  function resetInactivity() {
    if (done) return;
    if (inactivityHandle) clearTimeout(inactivityHandle);
    inactivityHandle = setTimeout(() => {
      if (done) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      killed = true;
      finishOnce(onError, "No output for 90s — gave up waiting");
    }, INACTIVITY_TIMEOUT_MS);
  }

  function finishOnce(fn, arg) {
    if (done) return;
    done = true;
    clearTimers();
    safeCall(fn, arg);
  }

  try {
    child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        // Required for mid-stream text_delta events. Without this flag, the
        // CLI only emits `system` / `assistant` snapshots / `result` — no
        // incremental text. Having deltas lets us mirror tool_use events and
        // (later) stream the reply live into the dialog.
        "--include-partial-messages",
      ],
      { cwd, env: process.env },
    );
  } catch (err) {
    safeCall(onError, err?.message ?? "spawn failed");
    return { cancel() {} };
  }

  // Kick off timers. Inactivity is reset on every stdout chunk; the hard
  // ceiling is absolute.
  resetInactivity();
  hardHandle = setTimeout(() => {
    if (done) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    killed = true;
    finishOnce(onError, "Hard 10 min timeout reached");
  }, HARD_TIMEOUT_MS);

  child.on("error", (err) => {
    finishOnce(onError, err?.message ?? "subprocess error");
  });

  child.stderr.on("data", (d) => {
    stderrBuf += d.toString();
  });

  child.stdout.on("data", (d) => {
    if (killed || done) return;
    resetInactivity();
    stdoutCarry += d.toString();
    let idx;
    while ((idx = stdoutCarry.indexOf("\n")) !== -1) {
      const line = stdoutCarry.slice(0, idx);
      stdoutCarry = stdoutCarry.slice(idx + 1);
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch (err) {
        console.warn(
          "[claude-spawner] skipping unparsable line:",
          err?.message ?? err,
        );
        continue;
      }
      handleEvent(evt);
    }
  });

  child.on("close", (code) => {
    if (done) return;
    if (killed) {
      // Caller already notified via cancel/timeout
      finishOnce(onDone);
      return;
    }
    if (code !== 0 && !sawResult) {
      finishOnce(
        onError,
        stderrBuf.trim() || `claude exited with code ${code}`,
      );
      return;
    }
    if (!sawResult) {
      // Exited 0 but no final `result` event — treat as error so UI can recover
      finishOnce(onError, stderrBuf.trim() || "claude ended without a result");
      return;
    }
    finishOnce(onDone);
  });

  function handleEvent(evt) {
    if (!evt || typeof evt !== "object") return;
    try {
      if (evt.type === "stream_event" && evt.event) {
        const inner = evt.event;
        if (
          inner.type === "content_block_delta" &&
          inner.delta?.type === "text_delta" &&
          typeof inner.delta.text === "string"
        ) {
          safeCall(onEvent, { type: "text", delta: inner.delta.text });
          return;
        }
        if (
          inner.type === "content_block_start" &&
          inner.content_block?.type === "tool_use"
        ) {
          safeCall(onEvent, {
            type: "tool_use",
            toolName: inner.content_block.name,
            input: inner.content_block.input,
          });
          return;
        }
        return;
      }
      if (evt.type === "result" && typeof evt.result === "string") {
        sawResult = true;
        safeCall(onEvent, { type: "done", fullText: evt.result });
        return;
      }
      // Other event types (system/assistant snapshots) — ignored for now.
    } catch (err) {
      console.warn(
        "[claude-spawner] subscriber threw:",
        err?.message ?? err,
      );
    }
  }

  return {
    cancel() {
      if (done || killed) return;
      killed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      // Don't call onError here — caller initiated the cancel. Let the close
      // handler fire onDone once the child actually exits.
    },
  };
}

function safeCall(fn, arg) {
  if (typeof fn !== "function") return;
  try {
    fn(arg);
  } catch (err) {
    console.warn("[claude-spawner] callback threw:", err?.message ?? err);
  }
}

module.exports = { spawnClaudeRequest };
