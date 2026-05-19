// Electron preload — runs in an isolated context with Node access, exposes a
// safe API on window.agentquest.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentquest", {
  isElectron: true,
  platform: process.platform,

  // Real-time claude lifecycle events forwarded from the local hook HTTP
  // server (see electron/hook-server.js). Each entry is `{ seq, payload }`
  // where `payload` is a raw Claude Code hook JSON. Subscribers should
  // remember the highest `seq` they've processed and pass it to
  // `hooks.replay({ sinceSeq })` on (re-)attach so that hooks fired
  // before the renderer mounted (or during a React strict-mode unmount)
  // are not lost. The provider layer dedupes by seq.
  subscribeHookEvents: (cb) => {
    const listener = (_event, entry) => {
      try {
        cb(entry);
      } catch (err) {
        console.error("[agentquest] hook subscriber threw", err);
      }
    };
    ipcRenderer.on("claude:hook", listener);
    return () => ipcRenderer.removeListener("claude:hook", listener);
  },

  hooks: {
    port: () => ipcRenderer.invoke("hooks:port"),
    install: () => ipcRenderer.invoke("hooks:install"),
    uninstall: () => ipcRenderer.invoke("hooks:uninstall"),
    isInstalled: () => ipcRenderer.invoke("hooks:isInstalled"),
    openSettings: () => ipcRenderer.invoke("hooks:openSettings"),
    replay: (sinceSeq) => ipcRenderer.invoke("hooks:replay", { sinceSeq }),
    status: () => ipcRenderer.invoke("hooks:status"),
    rebind: () => ipcRenderer.invoke("hooks:rebind"),
  },
  askClaude: ({ cwd, prompt }, onEvent) => {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handler = (_event, payload) => {
      if (!payload || payload.requestId !== requestId) return;
      try {
        onEvent(payload.event);
      } catch (err) {
        console.error("[agentquest] askClaude subscriber threw", err);
      }
    };
    ipcRenderer.on("claude:ask:event", handler);
    ipcRenderer.invoke("claude:ask", { requestId, cwd, prompt });
    return {
      cancel() {
        ipcRenderer.invoke("claude:cancel", { requestId });
      },
      dispose() {
        ipcRenderer.removeListener("claude:ask:event", handler);
      },
    };
  },

  // --- Terminal host (node-pty) ------------------------------------------
  terminal: {
    async spawn({ terminalId, cwd, shell, cols, rows, env } = {}) {
      return ipcRenderer.invoke("terminal:spawn", {
        terminalId,
        cwd,
        shell,
        cols,
        rows,
        env,
      });
    },
    write(terminalId, data) {
      return ipcRenderer.invoke("terminal:write", { terminalId, data });
    },
    resize(terminalId, cols, rows) {
      return ipcRenderer.invoke("terminal:resize", {
        terminalId,
        cols,
        rows,
      });
    },
    kill(terminalId) {
      return ipcRenderer.invoke("terminal:kill", { terminalId });
    },
    // Subscribe to stdout/stderr chunks. Caller filters by terminalId.
    onData(cb) {
      const listener = (_event, payload) => {
        try {
          cb(payload);
        } catch (err) {
          console.error("[agentquest] terminal.onData subscriber threw", err);
        }
      };
      ipcRenderer.on("terminal:data", listener);
      return () => ipcRenderer.removeListener("terminal:data", listener);
    },
    onExit(cb) {
      const listener = (_event, payload) => {
        try {
          cb(payload);
        } catch (err) {
          console.error("[agentquest] terminal.onExit subscriber threw", err);
        }
      };
      ipcRenderer.on("terminal:exit", listener);
      return () => ipcRenderer.removeListener("terminal:exit", listener);
    },
  },

  pickDirectory() {
    return ipcRenderer.invoke("dialog:showOpenDirectory");
  },

  // Given a numeric pid, raise the terminal-emulator app that hosts it
  // (iTerm / Terminal / Cursor / VS Code / etc). Returns { ok, app?, reason? }.
  focusExternalHost(pid) {
    return ipcRenderer.invoke("agent:focusExternalHost", { pid });
  },
});
