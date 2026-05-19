// Electron main process entry.
// In dev: loads http://localhost:3000 (the Next.js dev server)
// In prod: loads the built Next.js app via `next start` (spawned by the bundler script)

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { spawnClaudeRequest } = require("./claude-spawner.js");
const ptyHost = require("./pty-host.js");
const { startHookServer } = require("./hook-server.js");
const hookInstaller = require("./hook-installer.js");

// Hook-server state — populated at app boot. The stop function is called
// on quit so we release the port cleanly. `hookBindError` is set when
// startHookServer returned null (every retry port was busy or another
// fatal listen error); cleared on a successful (re-)bind. Surfaced via
// the `hooks:status` IPC so the UI can show a distinct "can't open
// port" state instead of the silent "no events" we used to ship.
let hookServerHandle = null;
let hookBindError = null;

// Bounded ring buffer of forwarded hook payloads. Hooks can fire before
// the renderer has mounted (cold launch) or during a React strict-mode
// unmount/mount window in dev — webContents.send drops to a window with
// no live listeners. We keep the last HOOK_BUFFER_CAP entries here and
// replay anything-the-renderer-missed via the `hooks:replay` IPC the
// first time it subscribes (and on every reload). Each entry carries a
// monotonic `seq` so the renderer can dedupe across replay + live.
const HOOK_BUFFER_CAP = 200;
const hookEventBuffer = [];
let nextHookSeq = 1;
let lastHookEventAt = 0;

function pushHookEvent(payload) {
  const entry = { seq: nextHookSeq++, payload };
  hookEventBuffer.push(entry);
  if (hookEventBuffer.length > HOOK_BUFFER_CAP) {
    hookEventBuffer.splice(0, hookEventBuffer.length - HOOK_BUFFER_CAP);
  }
  lastHookEventAt = Date.now();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("claude:hook", entry);
  }
}

// Walk a process's ancestry up to 8 levels looking for a known terminal
// emulator. Returns the AppleScript-compatible app name for `tell
// application "…" to activate`, or null if nothing matches.
const HOST_MAPPING = [
  { re: /iTerm/i, app: "iTerm" },
  { re: /Terminal\.app|\bTerminal$/i, app: "Terminal" },
  { re: /Cursor/i, app: "Cursor" },
  { re: /Code Helper|Visual Studio Code|\bCode\b/i, app: "Visual Studio Code" },
  { re: /Warp/i, app: "Warp" },
  { re: /Hyper/i, app: "Hyper" },
  { re: /Tabby/i, app: "Tabby" },
  { re: /Ghostty/i, app: "Ghostty" },
  { re: /Alacritty/i, app: "Alacritty" },
  { re: /kitty/i, app: "kitty" },
];
function identifyHostApp(pid) {
  let cur = pid;
  for (let i = 0; i < 8 && cur && cur > 1; i++) {
    let comm = "";
    try {
      comm = execFileSync("ps", ["-o", "comm=", "-p", String(cur)], {
        encoding: "utf8",
        timeout: 400,
      }).trim();
    } catch {
      return null;
    }
    for (const h of HOST_MAPPING) {
      if (h.re.test(comm)) return h.app;
    }
    try {
      const ppidOut = execFileSync("ps", ["-o", "ppid=", "-p", String(cur)], {
        encoding: "utf8",
        timeout: 200,
      }).trim();
      const ppid = parseInt(ppidOut, 10);
      if (!Number.isFinite(ppid) || ppid <= 1 || ppid === cur) return null;
      cur = ppid;
    } catch {
      return null;
    }
  }
  return null;
}

// Active `claude -p` subprocesses keyed by renderer-supplied requestId.
// Cleared when the request finishes (done/error) or is cancelled.
const activeClaudeRequests = new Map();

const isDev = !app.isPackaged;
const PROD_PORT = parseInt(process.env.NEXT_PORT || "3010", 10);

let mainWindow = null;
let nextServer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: "Agent Force HQ",
    backgroundColor: "#271d2e",
    // Native title bar with the traffic-light buttons above the content,
    // like any normal Mac app. Matches standard window chrome.
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    minWidth: 900,
    minHeight: 600,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const url = isDev
    ? process.env.AGENTQUEST_DEV_URL || "http://localhost:3017"
    : `http://localhost:${PROD_PORT}`;
  mainWindow.loadURL(url);

  if (isDev) {
    // Open devtools in production too would be obnoxious, but useful for dev.
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

function registerTerminalHandlers() {
  ipcMain.handle("terminal:spawn", (_event, payload) => {
    const {
      terminalId,
      cwd,
      shell: shellArg,
      cols,
      rows,
      env,
    } = (payload && typeof payload === "object" ? payload : {}) || {};
    if (!terminalId || typeof terminalId !== "string") {
      return { error: "missing terminalId" };
    }
    try {
      const entry = ptyHost.spawnTerminal({
        terminalId,
        cwd,
        shell: shellArg,
        cols,
        rows,
        env,
      });
      return { terminalId: entry.terminalId, pid: entry.pid, cwd: entry.cwd };
    } catch (err) {
      return { error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle("terminal:write", (_event, payload) => {
    const { terminalId, data } =
      (payload && typeof payload === "object" ? payload : {}) || {};
    if (!terminalId || typeof data !== "string") return { ok: false };
    return { ok: ptyHost.writeTerminal(terminalId, data) };
  });

  ipcMain.handle("terminal:resize", (_event, payload) => {
    const { terminalId, cols, rows } =
      (payload && typeof payload === "object" ? payload : {}) || {};
    if (!terminalId) return { ok: false };
    return { ok: ptyHost.resizeTerminal(terminalId, cols, rows) };
  });

  ipcMain.handle("terminal:kill", (_event, payload) => {
    const { terminalId } =
      (payload && typeof payload === "object" ? payload : {}) || {};
    if (!terminalId) return { ok: false };
    return { ok: ptyHost.killTerminal(terminalId) };
  });

  ipcMain.handle("dialog:showOpenDirectory", async () => {
    if (!mainWindow) return { canceled: true, path: null };
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths?.length) {
      return { canceled: true, path: null };
    }
    return { canceled: false, path: result.filePaths[0] };
  });

  // Forward pty output + exit events to the renderer.
  ptyHost.onTerminalData(({ terminalId, data }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal:data", { terminalId, data });
    }
  });
  ptyHost.onTerminalExit(({ terminalId, exitCode, signal }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal:exit", {
        terminalId,
        exitCode,
        signal,
      });
    }
  });
}

function registerHookHandlers() {
  ipcMain.handle("hooks:port", () => {
    return { port: hookServerHandle?.port ?? null };
  });

  ipcMain.handle("hooks:isInstalled", () => {
    try {
      return { installed: hookInstaller.isHooksInstalled() };
    } catch (err) {
      return { installed: false, error: String(err?.message ?? err) };
    }
  });

  ipcMain.handle("hooks:install", async () => {
    const port = hookServerHandle?.port;
    if (!port) {
      return { ok: false, error: "hook server not running" };
    }
    try {
      const result = hookInstaller.installHooks(port);
      return result;
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });

  ipcMain.handle("hooks:uninstall", () => {
    try {
      return hookInstaller.uninstallHooks();
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });

  // Composite health view of the hook pipeline. Combines: whether the
  // wrapper script is installed (`hookInstaller.isHooksInstalled`),
  // whether our local HTTP receiver is bound (`hookServerHandle.port`),
  // and how recently a hook actually arrived. The UI uses this to draw
  // a distinct "AgentQuest can't open its hook port" state — previously
  // a bind failure looked identical to "no agents running".
  ipcMain.handle("hooks:status", () => {
    let installed = false;
    try {
      installed = hookInstaller.isHooksInstalled();
    } catch {
      installed = false;
    }
    return {
      installed,
      port: hookServerHandle?.port ?? null,
      bound: !!hookServerHandle,
      bindError: hookBindError,
      lastEventAt: lastHookEventAt || null,
    };
  });

  // Try to (re-)bind the hook server. Used by the banner's "RETRY"
  // button after a startup bind failure. Safe to call when already
  // bound — short-circuits to success.
  ipcMain.handle("hooks:rebind", async () => {
    if (hookServerHandle) {
      return { ok: true, port: hookServerHandle.port };
    }
    hookServerHandle = await startHookServer((payload) => {
      pushHookEvent(payload);
    });
    if (!hookServerHandle) {
      return { ok: false, error: hookBindError };
    }
    hookBindError = null;
    return { ok: true, port: hookServerHandle.port };
  });

  // Replay any hooks the renderer missed. The renderer passes the highest
  // `seq` it has already processed (0 on first attach); we return every
  // newer entry. Keeps the buffer in main — repeat callers only ever see
  // newer entries, so duplicate replay across React strict-mode mounts
  // doesn't double up events.
  ipcMain.handle("hooks:replay", (_event, payload) => {
    const since =
      payload && typeof payload === "object" && Number.isFinite(payload.sinceSeq)
        ? Number(payload.sinceSeq)
        : 0;
    const entries = hookEventBuffer.filter((e) => e.seq > since);
    return { entries, latestSeq: nextHookSeq - 1 };
  });

  ipcMain.handle("hooks:openSettings", () => {
    try {
      shell.showItemInFolder(hookInstaller.settingsPath());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });
}

function registerAgentFocusHandler() {
  // Given a process pid, walk its ancestry to find the terminal emulator
  // (iTerm, VS Code, Cursor, etc) hosting it, and raise that app to the
  // foreground. For external claudes this is the best we can do — we
  // don't own their PTY so the renderer can't focus a specific tab.
  ipcMain.handle("agent:focusExternalHost", (_event, payload) => {
    const { pid } = (payload && typeof payload === "object" ? payload : {}) || {};
    if (!Number.isFinite(pid)) return { ok: false, reason: "bad-pid" };
    const appName = identifyHostApp(Number(pid));
    if (!appName) return { ok: false, reason: "unknown-host" };
    try {
      execFileSync(
        "osascript",
        ["-e", `tell application "${appName}" to activate`],
        { timeout: 1500 },
      );
      return { ok: true, app: appName };
    } catch (err) {
      return {
        ok: false,
        reason: "osascript-failed",
        message: String(err && err.message ? err.message : err),
      };
    }
  });
}

function registerClaudeAskHandlers() {
  ipcMain.handle("claude:ask", (_event, payload) => {
    const { requestId, cwd, prompt } =
      (payload && typeof payload === "object" ? payload : {}) || {};
    if (!requestId || typeof requestId !== "string") {
      return { error: "missing requestId" };
    }
    if (!cwd || typeof cwd !== "string") {
      return { error: "missing cwd" };
    }
    if (!prompt || typeof prompt !== "string") {
      return { error: "missing prompt" };
    }

    const send = (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("claude:ask:event", { requestId, event });
      }
    };

    const handle = spawnClaudeRequest({
      cwd,
      prompt,
      onEvent: (event) => send(event),
      onDone: () => {
        activeClaudeRequests.delete(requestId);
        send({ type: "done" });
      },
      onError: (message) => {
        activeClaudeRequests.delete(requestId);
        send({ type: "error", message: String(message ?? "unknown error") });
      },
    });

    activeClaudeRequests.set(requestId, handle);
    return { requestId };
  });

  ipcMain.handle("claude:cancel", (_event, payload) => {
    const requestId =
      payload && typeof payload === "object" ? payload.requestId : null;
    if (!requestId) return { ok: false };
    const handle = activeClaudeRequests.get(requestId);
    if (!handle) return { ok: false };
    try {
      handle.cancel();
    } catch {
      // ignore
    }
    activeClaudeRequests.delete(requestId);
    return { ok: true };
  });
}

function spawnProductionNextServer() {
  // In packaged builds, Next.js runs from its "standalone" output:
  // .next/standalone/server.js is a self-contained server that doesn't need
  // node_modules/next/.
  // When packaged, extraResources copies the standalone folder into
  // Contents/Resources/app/.next/standalone. Use process.resourcesPath.
  const standaloneRoot = path.join(
    process.resourcesPath,
    "app",
    ".next",
    "standalone",
  );
  const standalonePath = path.join(standaloneRoot, "server.js");

  nextServer = spawn(
    process.execPath,
    [standalonePath],
    {
      cwd: standaloneRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        ELECTRON_RUN_AS_NODE: "1",
        PORT: String(PROD_PORT),
        HOSTNAME: "127.0.0.1",
      },
      stdio: "inherit",
    },
  );
  nextServer.on("exit", (code) => {
    console.log(`[agentquest] next server exited ${code}`);
  });
}

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

app.whenReady().then(async () => {
  if (!isDev) {
    spawnProductionNextServer();
    await waitForServer(`http://localhost:${PROD_PORT}`);
  }
  // Boot the hook HTTP receiver first so we're ready whenever claude
  // fires hooks — doesn't matter if the renderer hasn't mounted yet;
  // events queue up in the IPC channel.
  hookServerHandle = await startHookServer((payload) => {
    pushHookEvent(payload);
  });
  if (!hookServerHandle) {
    hookBindError =
      "Couldn't open the hook port (47329-47333). Another app may be using it.";
    console.warn(`[agentquest] ${hookBindError}`);
  } else {
    hookBindError = null;
  }
  registerClaudeAskHandlers();
  registerTerminalHandlers();
  registerAgentFocusHandler();
  registerHookHandlers();
  createWindow();
});

app.on("window-all-closed", () => {
  if (nextServer) nextServer.kill();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (nextServer) nextServer.kill();
  for (const [, handle] of activeClaudeRequests) {
    try {
      handle.cancel();
    } catch {
      // ignore
    }
  }
  activeClaudeRequests.clear();
  try {
    ptyHost.killAll();
  } catch {
    // ignore
  }
  try {
    hookServerHandle?.stop();
  } catch {
    // ignore
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
