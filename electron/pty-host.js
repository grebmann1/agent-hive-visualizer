// Tiny registry of live pseudo-terminals keyed by a synthetic `terminalId`.
//
// The renderer calls spawnTerminal/writeTerminal/resizeTerminal/killTerminal
// via IPC (see main.js). Each PTY's stdout chunks are piped back to the
// renderer via the `onData` callback; exit events via `onExit`.
//
// The important quirk here is that we tag every PTY we spawn with an env var
// `AGENTQUEST_TERMINAL_ID=<id>`. When the user launches `claude` inside this
// PTY, the Claude process inherits the env var. The hook wrapper script
// (electron/hook-wrapper.sh) reads the env and splices the terminal id into
// every hook payload, which lets hook-provider.ts attribute hook events
// back to the terminal tab that launched claude.

const os = require("os");
const pty = require("node-pty");

// terminalId -> { pty, cwd, shell }
const live = new Map();

// Registered listeners: one per (mainWindow) lifecycle. Simple array of
// callbacks — the number of simultaneous callers is at most 1 in this app.
const dataListeners = [];
const exitListeners = [];

function defaultShell() {
  // Honor the user's $SHELL if set; fall back to zsh on mac, bash on linux.
  if (process.env.SHELL) return process.env.SHELL;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function defaultCwd() {
  return process.env.HOME || os.homedir() || process.cwd();
}

function spawnTerminal({ terminalId, cwd, shell, cols, rows, env }) {
  if (live.has(terminalId)) return live.get(terminalId);

  const resolvedShell = shell || defaultShell();
  const resolvedCwd = cwd || defaultCwd();

  // Merge env: inherit process env, set our tag + strip any conflicting vars.
  const resolvedEnv = {
    ...process.env,
    ...(env || {}),
    AGENTQUEST_TERMINAL_ID: terminalId,
    // Ensure TERM is something xterm.js understands so colors/ansi work.
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };

  const ptyProc = pty.spawn(resolvedShell, [], {
    name: "xterm-256color",
    cols: Number.isFinite(cols) ? cols : 80,
    rows: Number.isFinite(rows) ? rows : 24,
    cwd: resolvedCwd,
    env: resolvedEnv,
  });

  const entry = {
    terminalId,
    pty: ptyProc,
    cwd: resolvedCwd,
    shell: resolvedShell,
    pid: ptyProc.pid,
  };
  live.set(terminalId, entry);

  ptyProc.onData((data) => {
    for (const cb of dataListeners) {
      try {
        cb({ terminalId, data });
      } catch {
        // ignore
      }
    }
  });
  ptyProc.onExit(({ exitCode, signal }) => {
    for (const cb of exitListeners) {
      try {
        cb({ terminalId, exitCode, signal });
      } catch {
        // ignore
      }
    }
    live.delete(terminalId);
  });

  return entry;
}

function writeTerminal(terminalId, data) {
  const e = live.get(terminalId);
  if (!e) return false;
  try {
    e.pty.write(data);
    return true;
  } catch {
    return false;
  }
}

function resizeTerminal(terminalId, cols, rows) {
  const e = live.get(terminalId);
  if (!e) return false;
  try {
    e.pty.resize(
      Number.isFinite(cols) ? cols : 80,
      Number.isFinite(rows) ? rows : 24,
    );
    return true;
  } catch {
    return false;
  }
}

function killTerminal(terminalId) {
  const e = live.get(terminalId);
  if (!e) return false;
  try {
    e.pty.kill();
  } catch {
    // ignore — already dead
  }
  live.delete(terminalId);
  return true;
}

function onTerminalData(cb) {
  dataListeners.push(cb);
  return () => {
    const i = dataListeners.indexOf(cb);
    if (i >= 0) dataListeners.splice(i, 1);
  };
}

function onTerminalExit(cb) {
  exitListeners.push(cb);
  return () => {
    const i = exitListeners.indexOf(cb);
    if (i >= 0) exitListeners.splice(i, 1);
  };
}

function killAll() {
  for (const id of Array.from(live.keys())) {
    killTerminal(id);
  }
}

module.exports = {
  spawnTerminal,
  writeTerminal,
  resizeTerminal,
  killTerminal,
  onTerminalData,
  onTerminalExit,
  killAll,
};
