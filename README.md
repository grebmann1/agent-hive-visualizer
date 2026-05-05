# AgentQuest

A 2D pixel-art desktop app where every AI agent becomes a visible character.
Walk around a little top-down world, talk to agents, and watch every live
`claude` CLI instance on your laptop appear as its own NPC in real time.

Built with Next.js, Phaser, Zustand, and Electron. Packaged as a native macOS
app.

## Quick start

```bash
npm install
npm run dev
```

That launches the Next.js dev server and opens the Electron window. The
app is ready when the AgentQuest window appears.

## Controls

| Action                   | Keys                     |
| ------------------------ | ------------------------ |
| Walk                     | Arrow keys / WASD        |
| Talk to the facing agent | `E` or `Enter`           |
| Advance dialogue         | `Space`, `Enter`, or `E` |
| Send a message           | Type + `Enter`           |
| Close a dialog           | `Esc`                    |

Touch controls (on-screen D-pad + A/B) appear automatically on narrow
screens.

## Agents

**AgentQuest v1.2 is Claude-only.** The four built-in NPCs from earlier
versions (Codey / Searchy / Testy / Toolsmith) are gone. Every NPC you
meet in the world is a **real `claude` CLI process** running on your
laptop. No live claudes means an empty world (just you, the player).

**How an agent appears**: open a terminal, `cd` into any project, and
run `claude`. Within a few seconds you'll see a new NPC pop into the
world with a unique silhouette + color (hash-assigned per PID) and a
**LIVE** badge in the Agents panel.

**How an agent moves**: the app tails that Claude's session transcript
at `~/.claude/projects/{cwd}/{sessionId}.jsonl` and maps each tool-use
to a room in the game. The NPC walks to the right room *and* plays a
tool-specific animation:

| Tool Claude runs | Room it walks to | Animation | Emoji |
| --- | --- | --- | --- |
| `Read` | Library | faces shelf, sways | 📖 |
| `Edit`/`Write`/`MultiEdit` | Scriptorium | typing pulse | ⌨️ |
| `Bash` | Forge | hammer swings | 🔧 |
| `Grep`/`Glob` | Library | 4-direction scan | 🔍 |
| `WebFetch`/`WebSearch` | Forge | opacity pulse | 🌐 |
| `TodoWrite` | Hearth | checkmark flashes | ✓ |
| `Task` (sub-agent) | Hearth | directing pose + helper dwarf | 📜 |
| *(idle)* | anywhere | subtle bob | — |

**Sub-agents**: when a Claude uses the `Task` tool to spawn a
sub-agent, a small **helper dwarf** sprite pops in next to the parent,
tinted by the sub-agent's type. If the sub-agent runs as its own
process (typical for Claude Code `Task`), the new PID is detected
separately and linked: it spawns *next to* its parent with a faint
dotted tether between them and appears as a nested row under the
parent in the Agents panel.

**Chatting**: walk up to an NPC and press `E`. Your message spawns a
real `claude -p` subprocess inside that NPC's working directory — the
reply **streams** into the dialog as it's generated. A status line in
the dialog header shows the current tool call (*Reading src/foo.ts*)
and a visible **[CANCEL]** button aborts at any time.

**Demo mode**: no live Claude? Click **▶ DEMO** in the Agents panel for
a synthetic NPC that walks through every choreography beat — including
a Task→sub-agent spawn+despawn — in about 20 seconds.

## Zones

The world has two zones:

- **Agent HQ** (`interior`) — 24×16 building with the 5 rooms and all NPCs.
- **The Plaza** (`plaza`) — 16×12 outdoor courtyard with some plants and chairs.

Walk to the door-gap at the bottom-center of the interior to step
outside. Walk into the top-center of the plaza to come back in.

## Chatting with agents

Every conversation routes to the Claude API. Set your key in
`.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Without a key, agents reply with a friendly fallback so you can still
walk around.

The model is `claude-haiku-4-5-20251001` with a persona-specific system
prompt per NPC.

When a chat begins, the agent's visible "activity" updates with a
heuristic: if you ask it to build something it walks over to the coding
room, if you ask it to search it walks to the library, etc. Each state
change shows as an overhead bubble above the NPC and as a line in the
roster panel.

## How the Claude process monitor works

`electron/claude-monitor.js` polls `ps -Ao pid=,lstart=,command=` every
~2.5 seconds, filters processes whose command line matches
`/(^|\/|\s)claude(\s|$)/`, excludes false positives (Electron bundle,
`node_modules/`, Next.js), and emits `join` / `leave` / `refresh`
events over IPC.

The renderer subscribes via `window.agentquest.subscribeClaudeEvents`
(exposed in `electron/preload.js` under `contextBridge`). Each join
spawns a dynamic NPC via `useNpcStore.addDynamic` with a stable
palette/room derived from a hash of the PID-based id. When the process
exits, the NPC fades out.

## Architecture

```
electron/
  main.js              # Electron entry, BrowserWindow, IPC handlers
  preload.js           # contextBridge: window.agentquest
  claude-monitor.js    # ps-polling Claude process watcher (join/leave)
  transcript-watcher.js # Tails ~/.claude/projects/*.jsonl per PID
  claude-spawner.js    # Spawns `claude -p` subprocesses for LIVE NPCs
  pid-cwd.js           # Shared lsof-based cwd resolver

src/
  app/
    page.tsx           # Main layout
    api/chat/route.ts  # Anthropic proxy (accepts inline persona for dynamic NPCs)
  components/
    GameCanvas.tsx     # Dynamic Phaser loader
    GameCanvasInner.tsx
    DialogBox.tsx      # Pokemon-style dialog w/ typewriter;
                       # routes LIVE NPCs through `claude -p`, built-ins through /api/chat
    HudOverlay.tsx     # DOM overlay on the canvas (zone/room label, hints)
    AgentRoster.tsx    # Right-side agent list with LIVE badges
    ClaudeMonitorBridge.tsx  # Electron IPC -> NPC store + activity
    TouchControls.tsx  # Mobile D-pad
    Intro.tsx          # First-run modal
  game/
    WorldScene.ts      # Phaser.Scene: tiles, NPCs, input, BFS pathing
    zones.ts           # Multi-zone world: interior + plaza + transitions
    rooms.ts           # Backward-compat re-exports from the interior zone
    pixelArt.ts        # Kenney asset bindings + palette-swap tint
    pathfind.ts        # BFS grid pathfinding
    npcs.ts            # Static NPC roster
    palette.ts         # GB palette (used for camera bg) + tile size
  stores/
    useGameStore.ts    # Player + dialog state
    useAgentStore.ts   # Event stream + per-agent activities
    useNpcStore.ts     # Static + dynamic NPC roster
  events/
    types.ts           # AgentEvent contract
    visualRules.ts     # event -> room/animation mapping
```

All pixel art comes from the Kenney "Tiny Dungeon" pack (CC0,
`public/assets/LICENSE-kenney.txt`). The tileset is `public/assets/tilesets/tiny-dungeon.png`; the character sheet is `public/assets/characters/base.png`.
Per-NPC color variation comes from a palette swap on the base sprite
(see `pixelArt.ts::buildCharacterCanvasTinted`). The surrounding UI
chrome uses a parchment palette so text is readable at any zoom.

## Extending the game

The game has three declarative registries that make it easy to add new
behavior without touching most of the code:

### Add a new agent behavior

Agent actions (Read, Edit, Bash, Task, …) are defined in
`src/game/behaviors.ts`. Each entry declares which room the NPC walks
to, which choreography it plays, and how the event is described. To
add a new one:

```ts
// src/game/behaviors.ts
BEHAVIORS.push({
  id: "deploy",
  label: "Deploying",
  room: "tool_workshop",
  choreo: "hammering",
  matches: (e) => e.metadata?.toolName === "Deploy",
  describe: (e) => `Deploying to ${getStr(e, "target", "input") ?? "prod"}`,
});
```

That's it — no other file changes.

### Add a new room

Rooms are declared in `src/game/zones.ts` (layout tiles) and
`src/game/room-registry.ts` (labels + tags). To add a "Reception"
room:

1. Add an entry to `INTERIOR_ZONE.layout` (walls) and `.decor` (tiles).
2. Add a `RoomId` literal in `src/events/types.ts`.
3. Append a `RoomDef` in `room-registry.ts` with descriptive tags.
4. Reference the new room from any behavior.

### Plug a new agent provider

All agent sources implement the `AgentProvider` interface in
`src/agents/provider.ts`. The existing `ClaudeCodeProvider` is the
reference impl — copy its shape, swap the subscription source:

```ts
// src/agents/openai-provider.ts
import type { AgentProvider, AgentProviderAPI } from "./provider";

export class OpenAIProvider implements AgentProvider {
  readonly name = "openai";
  start(api: AgentProviderAPI): () => void {
    // Subscribe to your source — a websocket, an EventSource, whatever.
    const sub = openai.onEvent((e) => {
      api.upsertAgent({
        id: `openai:${e.sessionId}`,
        displayName: e.user,
        providerName: "openai",
        cwd: e.cwd,
      });
      api.emitEvent({
        type: "agent.state.changed",
        agentId: `openai:${e.sessionId}`,
        state: "coding",
        message: "",
        timestamp: new Date().toISOString(),
        metadata: { toolName: e.tool, input: e.input },
      });
    });
    return () => sub.unsubscribe();
  }
}
```

Register it once at app boot in
`src/components/ClaudeMonitorBridge.tsx::ensureRegistered`:

```ts
registerProvider(new OpenAIProvider());
```

The provider only needs to produce `AgentEvent`s — the behavior
registry handles the visual routing uniformly across providers, so
an "Edit" from OpenAI looks the same as an "Edit" from Claude Code.

## Scripts

| Command             | What                                                    |
| ------------------- | ------------------------------------------------------- |
| `npm run dev`       | Next dev server + Electron (primary dev flow)           |
| `npm run dev:web`   | Next dev server only (port 3017)                        |
| `npm run build:web` | Next production build                                   |
| `npm run pack`      | Build + package app as unsigned `.app` (dev distribution) |
| `npm run dist`      | Build + produce `.dmg` in `release/` (signed if env set) |
| `npm run typecheck` | TypeScript check (no emit)                              |

## Distribution

`npm run dist` always produces a `.dmg` in `release/`. Whether it's
signed and notarized depends on your environment.

### Unsigned (default)

Just run:

```bash
npm run dist
```

Produces two `.dmg` files (arm64 + x64). macOS Gatekeeper will block
the first launch — right-click the app → Open → confirm the warning
dialog once. Good for hand-carrying builds to teammates.

### Signed + notarized

Set these before running `npm run dist`:

| Env var                       | Meaning                                                |
| ----------------------------- | ------------------------------------------------------ |
| `CSC_LINK`                    | Path or URL to your `.p12` Developer ID cert          |
| `CSC_KEY_PASSWORD`            | Password for the `.p12`                                |
| `APPLE_ID`                    | Your Apple developer account email                     |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password (NOT your AppleID password)     |
| `APPLE_TEAM_ID`               | 10-char Developer Team ID                              |

The `afterSign` hook (`build/notarize.js`) submits the signed `.app` to
Apple. Notarization takes ~2–15 min; `electron-builder` blocks until
Apple finishes. A successful run produces a `.dmg` that passes
Gatekeeper on any Mac.

Entitlements are declared in `build/entitlements.mac.plist` — we
allow JIT (V8), unsigned executable memory, library validation off,
and network client/server (for the embedded Next.js server calling
`api.anthropic.com`).

## Native build details

In packaged builds, the embedded Next.js server runs from its
`standalone` output (`.next/standalone/server.js`) — no need to ship
`node_modules/next/` inside the app bundle. `electron/main.js`
spawns that server on port 3010 and waits for a 200 response before
showing the window.

## License

MIT for this project's source. Pixel art: Kenney.nl, CC0.
