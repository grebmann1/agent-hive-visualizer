// Local HTTP receiver for Claude Code hook events.
//
// Each time Claude fires a hook (PreToolUse, PostToolUse, Stop, etc.),
// the wrapper script at ~/.agentquest/bin/post-hook.sh POSTs the hook's
// JSON payload to this server. We validate that the connection is local,
// parse the body, and forward it to the renderer via `onHook`.
//
// The server binds ONLY to 127.0.0.1, so it's invisible to other machines
// on the network. Node's listen() already enforces this — the remote-
// address check below is defense in depth.

const http = require("node:http");

const DEFAULT_PORT = 47329;
const MAX_BODY_BYTES = 256 * 1024; // way more than any real hook payload

// Whitelist of `hook_event_name` values we expect from Claude. Anything
// outside this set is logged once but still forwarded — Claude may add
// new hook types in the future and we want to know about them without
// silently dropping the event.
const KNOWN_HOOK_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStop",
  "Notification",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
]);

const seenUnknownEvents = new Set();

/**
 * Validate a parsed hook payload. Returns `{ ok: true }` for shapes we
 * trust, or `{ ok: false, reason }` for shapes that should be rejected
 * with a 400. We're permissive on optional fields (Claude's payloads
 * carry a long tail of metadata) but strict on the two we always read:
 * the event name string and the agent identity.
 */
function validateHookPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "payload is not an object" };
  }
  const event = payload.hook_event_name;
  if (typeof event !== "string" || event.length === 0) {
    return { ok: false, reason: "missing hook_event_name" };
  }
  // session_id is the canonical agent key; without one we can't route.
  // The wrapper script sets it from $CLAUDE_SESSION_ID.
  const session = payload.session_id;
  if (typeof session !== "string" || session.length === 0) {
    return { ok: false, reason: "missing session_id" };
  }
  if (!KNOWN_HOOK_EVENTS.has(event) && !seenUnknownEvents.has(event)) {
    seenUnknownEvents.add(event);
    console.info(
      `[hook-server] unknown hook event "${event}" — forwarding anyway`,
    );
  }
  return { ok: true };
}

/**
 * Start a hook-receiver HTTP server. Tries `preferredPort` first and falls
 * back to the next 4 ports if that one is busy. Returns `{ port, stop }`
 * on success or `null` if we couldn't bind any port.
 *
 * `onHook(payload)` is called with the parsed JSON body for every valid
 * POST to /hook.
 */
function startHookServer(onHook, preferredPort = DEFAULT_PORT) {
  return new Promise((resolve) => {
    let port = preferredPort;
    let attempts = 0;

    const server = http.createServer((req, res) => {
      const remote = req.socket.remoteAddress;
      const loopback =
        remote === "127.0.0.1" ||
        remote === "::1" ||
        remote === "::ffff:127.0.0.1";
      if (!loopback) {
        res.statusCode = 403;
        res.end();
        return;
      }
      if (req.method !== "POST" || req.url !== "/hook") {
        res.statusCode = 404;
        res.end();
        return;
      }
      let body = "";
      let aborted = false;
      req.on("data", (chunk) => {
        if (aborted) return;
        body += chunk;
        if (body.length > MAX_BODY_BYTES) {
          aborted = true;
          req.destroy();
        }
      });
      req.on("end", () => {
        if (aborted) return;
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (err) {
          console.warn(
            "[hook-server] rejected payload — invalid JSON:",
            err && err.message ? err.message : err,
          );
          res.statusCode = 400;
          res.end();
          return;
        }
        const check = validateHookPayload(parsed);
        if (!check.ok) {
          console.warn(
            `[hook-server] rejected payload — ${check.reason}. Keys: ${Object.keys(parsed || {}).join(", ")}`,
          );
          res.statusCode = 400;
          res.end();
          return;
        }
        try {
          onHook(parsed);
        } catch (err) {
          console.warn("[hook-server] onHook threw:", err);
        }
        res.statusCode = 204;
        res.end();
      });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && attempts < 4) {
        attempts += 1;
        port += 1;
        try {
          server.listen(port, "127.0.0.1");
        } catch {
          resolve(null);
        }
      } else {
        console.warn(
          `[hook-server] couldn't bind to ${port}:`,
          err.message ?? err,
        );
        resolve(null);
      }
    });

    server.on("listening", () => {
      console.log(`[hook-server] listening on 127.0.0.1:${port}`);
      resolve({
        port,
        stop() {
          try {
            server.close();
          } catch {
            // ignore
          }
        },
      });
    });

    server.listen(port, "127.0.0.1");
  });
}

module.exports = { startHookServer, DEFAULT_PORT };
