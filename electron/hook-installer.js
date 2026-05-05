// Hook installer.
//
// Responsibilities:
//   - Write the hook-relay shell script to `~/.agentquest/bin/post-hook.sh`
//     with the current AgentQuest HTTP port baked in.
//   - Merge our hook entries into `~/.claude/settings.json` (one entry per
//     hook event AgentQuest cares about). Preserves existing hooks.
//   - Detect the install state (is our wrapper script referenced in the
//     settings file?).
//   - Remove our entries cleanly, leaving other hooks untouched.
//
// The installer is deliberately paranoid: it will refuse to touch a
// settings.json that won't parse as strict JSON. A backup of the original
// is written to `~/.claude/settings.json.bak.agentquest` on first install
// (only once; later installs reuse it).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Events we listen to. Adding a new one here is enough to register it
// after the next install.
const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SessionEnd",
];

function homeDir() {
  return process.env.HOME || os.homedir();
}

function wrapperPath() {
  return path.join(homeDir(), ".agentquest", "bin", "post-hook.sh");
}

function settingsPath() {
  return path.join(homeDir(), ".claude", "settings.json");
}

function backupPath() {
  return path.join(homeDir(), ".claude", "settings.json.bak.agentquest");
}

function readSettings() {
  const p = settingsPath();
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, "utf8");
  if (!raw.trim()) return {};
  // Strict parse — refuse to touch files with comments, trailing commas,
  // etc. Surface a clear error so the user can fix it themselves.
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `~/.claude/settings.json isn't valid JSON (${err.message}). ` +
        `Fix it manually, then try installing hooks again.`,
    );
  }
}

function writeSettings(obj) {
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const serialized = JSON.stringify(obj, null, 2) + "\n";
  fs.writeFileSync(p, serialized, "utf8");
}

function backupIfNeeded() {
  const src = settingsPath();
  const dst = backupPath();
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dst)) return; // already backed up
  fs.copyFileSync(src, dst);
}

/**
 * Install the wrapper script and merge AgentQuest hooks into settings.json.
 * `port` is the current HTTP port chosen by hook-server at startup.
 */
function installHooks(port) {
  if (!Number.isFinite(port)) {
    throw new Error("installHooks: invalid port");
  }
  // 1. Write wrapper script (read template from alongside this file).
  const template = fs.readFileSync(
    path.join(__dirname, "hook-wrapper.sh"),
    "utf8",
  );
  const scriptContents = template.replace(/__PORT__/g, String(port));
  const scriptPath = wrapperPath();
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, scriptContents, { mode: 0o755 });
  // Explicit chmod in case the OS clamps mode on writeFileSync.
  fs.chmodSync(scriptPath, 0o755);

  // 2. Merge hooks into settings.json.
  backupIfNeeded();
  const settings = readSettings();
  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }

  for (const event of HOOK_EVENTS) {
    const arr = Array.isArray(settings.hooks[event])
      ? settings.hooks[event]
      : [];
    // Drop any previous AgentQuest entry for this event (to support
    // reinstall without duplicates).
    const filtered = arr.filter((entry) => !isOurEntry(entry));
    filtered.push(ourEntry());
    settings.hooks[event] = filtered;
  }

  writeSettings(settings);
  return { ok: true, scriptPath, settingsPath: settingsPath() };
}

function uninstallHooks() {
  // 1. Remove our entries from settings.json (if it exists).
  const p = settingsPath();
  if (fs.existsSync(p)) {
    const settings = readSettings();
    if (settings.hooks && typeof settings.hooks === "object") {
      for (const event of Object.keys(settings.hooks)) {
        const arr = settings.hooks[event];
        if (!Array.isArray(arr)) continue;
        const filtered = arr.filter((entry) => !isOurEntry(entry));
        if (filtered.length === 0) {
          delete settings.hooks[event];
        } else {
          settings.hooks[event] = filtered;
        }
      }
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
      writeSettings(settings);
    }
  }
  // 2. Leave the wrapper script on disk — it's harmless when no hooks
  //    reference it. Re-install doesn't need to rewrite it.
  return { ok: true };
}

function isHooksInstalled() {
  const p = settingsPath();
  if (!fs.existsSync(p)) return false;
  let settings;
  try {
    settings = readSettings();
  } catch {
    return false;
  }
  if (!settings.hooks || typeof settings.hooks !== "object") return false;
  for (const arr of Object.values(settings.hooks)) {
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (isOurEntry(entry)) return true;
    }
  }
  return false;
}

function isOurEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (!Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) =>
      h &&
      typeof h === "object" &&
      typeof h.command === "string" &&
      h.command.includes("agentquest") &&
      h.command.includes("post-hook.sh"),
  );
}

function ourEntry() {
  return {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: `bash ${wrapperPath()}`,
        timeout: 2,
      },
    ],
  };
}

module.exports = {
  installHooks,
  uninstallHooks,
  isHooksInstalled,
  settingsPath,
  wrapperPath,
  HOOK_EVENTS,
};
