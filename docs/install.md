# Install & connect Claude

Agent Force HQ doesn't snoop on `claude` — it relies on Claude Code's
**hooks** to push events into the app. Without hooks installed, the
canvas stays empty even with live `claude` sessions running.

This page walks through:

1. Installing the **Agent Force HQ app** itself (DMG, dev build, or
   from source).
2. The two hook-install paths (one-click and manual).
3. What gets written to your machine.
4. How to verify the connection.
5. How to uninstall cleanly.

---

## 0. Get the app

### Option A — DMG (recommended)

Download the latest `Agent Force HQ-<version>.dmg` from the
project's GitHub Releases page, double-click it, and drag
**Agent Force HQ.app** onto **Applications**. Universal binary
(Apple Silicon + Intel).

The first time you launch it, macOS Gatekeeper may complain because
the DMG is signed but not notarized for free distribution yet —
right-click the app → **Open** → **Open** to bypass once. After
that it launches like any other app.

### Option B — Build the DMG locally

```bash
git clone https://github.com/grebmann1/agent-hive-visualizer.git
cd agent-hive-visualizer
npm install
npm run dist
open "release/Agent Force HQ-0.1.0.dmg"
```

See [`build-installer.md`](build-installer.md) for the full build
documentation, signing, and notarization.

### Option C — Run from source (dev mode)

```bash
git clone https://github.com/grebmann1/agent-hive-visualizer.git
cd agent-hive-visualizer
npm install
npm run dev
```

Launches the Next.js dev server and opens the Electron window with
hot reload. Best for poking at the code.

---

## 1. The one-click install

The fastest path. The first time you launch Agent Force HQ, a banner
appears at the top of the window:

> ◆ LIVE HOOKS NOT INSTALLED — Agent Force HQ hasn't wired itself
> into Claude. Click **Install hooks** to start showing live activity.

Clicking **Install hooks** does three things, all idempotent:

1. Writes a small relay shell script to
   `~/.agentquest/bin/post-hook.sh`. The script's only job is to
   forward Claude's hook payload to the local Agent Force HQ HTTP
   server (`127.0.0.1:47329` by default).
2. Backs up your existing `~/.claude/settings.json` to
   `~/.claude/settings.json.bak.agentquest` (only on the very first
   install — subsequent installs reuse the same backup).
3. Merges Agent Force HQ's hook entries into the `hooks` block of
   `~/.claude/settings.json`. **Existing hooks are preserved** — the
   installer never overwrites unrelated entries.

After install the banner replaces itself with a green
"◆ LIVE HOOKS INSTALLED" indicator. Run `claude` in any project — the
agent should appear inside the **Reception** rect within a couple of
seconds.

---

## 2. What the install actually writes

If you'd rather see what changes before you run anything, here's the
full picture.

### a) The relay script `~/.agentquest/bin/post-hook.sh`

```bash
#!/bin/bash
# Agent Force HQ hook relay.
#
# Reads a Claude hook payload on stdin, optionally splices in a
# terminal id, and POSTs the JSON to the local app. Fire-and-forget
# so claude never blocks on the bridge.

set -u

INPUT=$(cat)
TERMINAL_ID="${AGENTQUEST_TERMINAL_ID:-}"

if [ -n "$TERMINAL_ID" ]; then
  INPUT=$(printf '%s' "$INPUT" \
    | sed "s#^{#{\"agentquest_terminal_id\":\"$TERMINAL_ID\",#")
fi

(
  curl -sf --max-time 0.4 -X POST "http://127.0.0.1:47329/hook" \
    -H "Content-Type: application/json" \
    --data-binary "$INPUT" \
    >/dev/null 2>&1
) &

exit 0
```

Read it before installing if you'd like — it never leaves
`127.0.0.1`. Output is silently dropped if Agent Force HQ isn't
running, so it never hangs Claude.

### b) The merged `~/.claude/settings.json`

For every hook event Agent Force HQ cares about
(`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `Stop`, `SessionEnd`), the installer adds a
single matcher-`*` entry that calls the relay script. A typical merged
block looks like:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      // …your existing PreToolUse entries…
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash /Users/you/.agentquest/bin/post-hook.sh",
            "timeout": 2
          }
        ]
      }
    ]
    // …same shape for the other 6 events…
  }
}
```

A 2-second timeout caps the wrapper so any blip in the local server
can't slow Claude down. The `&` background invocation in the script
itself means hooks return immediately even if curl is still running.

### c) The local HTTP receiver

`electron/hook-server.js` listens on `127.0.0.1:47329` and validates
every payload (it must carry `hook_event_name` + `session_id`). The
server **only binds to loopback** so other machines on your network
can't reach it. If port 47329 is busy, Agent Force HQ falls back to
the next four ports automatically; the install button always uses the
port the app actually bound to.

---

## 3. Manual install

If you don't want to run the installer (locked-down machines,
read-only home directories, custom hook setup), do it by hand.

### Write the relay script yourself

```bash
mkdir -p ~/.agentquest/bin
cat > ~/.agentquest/bin/post-hook.sh <<'EOF'
#!/bin/bash
set -u
INPUT=$(cat)
TERMINAL_ID="${AGENTQUEST_TERMINAL_ID:-}"
if [ -n "$TERMINAL_ID" ]; then
  INPUT=$(printf '%s' "$INPUT" \
    | sed "s#^{#{\"agentquest_terminal_id\":\"$TERMINAL_ID\",#")
fi
(
  curl -sf --max-time 0.4 -X POST "http://127.0.0.1:47329/hook" \
    -H "Content-Type: application/json" \
    --data-binary "$INPUT" \
    >/dev/null 2>&1
) &
exit 0
EOF
chmod +x ~/.agentquest/bin/post-hook.sh
```

Replace `47329` if Agent Force HQ told you a different port at
launch (look for `[hook-server] listening on 127.0.0.1:<port>` in the
DevTools console).

### Add the entries to `~/.claude/settings.json`

Open the file and add (or merge into) the `hooks` block:

```jsonc
{
  "hooks": {
    "SessionStart":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash ~/.agentquest/bin/post-hook.sh", "timeout": 2 }] }],
    "UserPromptSubmit":   [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash ~/.agentquest/bin/post-hook.sh", "timeout": 2 }] }],
    "PreToolUse":         [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash ~/.agentquest/bin/post-hook.sh", "timeout": 2 }] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash ~/.agentquest/bin/post-hook.sh", "timeout": 2 }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash ~/.agentquest/bin/post-hook.sh", "timeout": 2 }] }],
    "Stop":               [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash ~/.agentquest/bin/post-hook.sh", "timeout": 2 }] }],
    "SessionEnd":         [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash ~/.agentquest/bin/post-hook.sh", "timeout": 2 }] }]
  }
}
```

If `~/.claude/settings.json` already has hooks, **append** the
matcher-`*` entries to the existing arrays — don't replace them.

---

## 4. Verify the connection

After installing, run `claude` in any project. You should see:

- A new NPC appear in the **Reception** rect of Agent Force HQ.
- The pill above the head fills with the cwd basename and an emoji
  for the current state (💭 idle, ⌨️ coding, …).
- The roster on the right gains a row for the new agent.

If nothing shows up:

1. Open the app's DevTools (it auto-opens in dev mode) and look for
   `[hook-server] listening on 127.0.0.1:<port>`. Note the port.
2. From a fresh shell, fire a synthetic event:
   ```bash
   curl -sf -X POST "http://127.0.0.1:<port>/hook" \
     -H "Content-Type: application/json" \
     -d '{"hook_event_name":"SessionStart","session_id":"smoke-test","cwd":"/tmp"}'
   ```
   A "SMOKE-TEST" agent should appear in the canvas.
3. If that works but `claude` still doesn't trigger anything, check
   `cat ~/.claude/settings.json` — Agent Force HQ's wrapper line
   should be there.
4. If nothing changes the settings file, the install button hit a
   permissions error. The DevTools console logs the failure; usually
   it's because `~/.claude/settings.json` is owned by another user
   or symlinked into a read-only volume.

---

## 5. Uninstall

Click **Disable hooks** in the in-app Hook Setup banner (or remove
manually):

- Removes Agent Force HQ's matcher-`*` entries from
  `~/.claude/settings.json`. **Other hooks are kept.**
- Leaves `~/.agentquest/bin/post-hook.sh` on disk (harmless without
  the settings entries, and avoids re-prompting on the next install).
- Leaves the backup at
  `~/.claude/settings.json.bak.agentquest` so you can revert manually
  if anything looks off.

To wipe completely:

```bash
rm -rf ~/.agentquest
mv ~/.claude/settings.json.bak.agentquest ~/.claude/settings.json  # if you want to revert to the original
```

---

## 6. Privacy

- The hook server binds to `127.0.0.1` only — never to a routable
  interface. Other machines on your network can't reach it.
- Hook payloads contain prompt text, tool inputs, and tool outputs
  that Claude itself sees. They never leave your machine — Agent
  Force HQ has no outbound network calls in the hook pipeline.
- The wrapper script's `curl` has a 400 ms timeout and uses
  `>/dev/null 2>&1`, so failures are silent (it never blocks Claude
  even if the server is missing).
- The local HTTP server logs an `info` line for unknown hook event
  types so we can extend coverage; it never logs payload content.

If you want to audit what's being sent, run Agent Force HQ in dev
mode and watch the **Activity** modal for any agent — it shows the
exact JSON the wrapper forwarded.
