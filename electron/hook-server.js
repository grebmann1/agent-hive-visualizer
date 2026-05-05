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
        try {
          const parsed = JSON.parse(body);
          try {
            onHook(parsed);
          } catch (err) {
            console.warn("[hook-server] onHook threw:", err);
          }
          res.statusCode = 204;
          res.end();
        } catch {
          res.statusCode = 400;
          res.end();
        }
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
