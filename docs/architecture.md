# How Agent Force HQ works

A walkthrough of the data flow, the rendering layers, and the visual
vocabulary. Read this once and you'll know which file to look at when
something doesn't move the way you expect.

---

## 1. The pipeline, end to end

```
┌──────────────────────────┐
│ claude (any terminal)    │  hook fires
└────────────┬─────────────┘
             │ JSON via stdin
             ▼
┌──────────────────────────┐
│ ~/.agentquest/bin/        │  fire-and-forget POST
│ post-hook.sh              │
└────────────┬─────────────┘
             │ HTTP 127.0.0.1:47329/hook
             ▼
┌──────────────────────────┐
│ electron/hook-server.js   │  validate + relay
└────────────┬─────────────┘
             │ IPC "claude:hook"
             ▼
┌──────────────────────────┐
│ src/agents/hook-provider  │  toolToState, parent linker
│  + registry.ts            │  upsertAgent / emitEvent
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│ Zustand stores            │  useNpcStore + useAgentStore
└────────────┬─────────────┘
             │ React subs + Phaser ticks
             ▼
┌──────────────────────────┐
│ src/game/WorldScene.ts    │  walkNpcToRoom, choreo, badges,
│  + behaviors.ts           │  tethers, ambient layers
└──────────────────────────┘
```

Two background loops run alongside it:

- **Idle-sit loop** (`tickIdleSit`, every 2 s) — any NPC quiet for
  60 s walks to a free desk seat and sits.
- **Idle eviction** (`HookProvider.sweepIdle`, every 30 s) — any NPC
  with no events for 10 minutes is removed entirely.

---

## 2. From hook to room

The hook payload's `tool_name` (or `state` for synthetic events) is
mapped through three small tables before the agent moves a pixel:

```
tool_name            ──▶  toolToState  ──▶  AgentState
                          (hook-provider.ts:165)

AgentState           ──▶  stateToRoom  ──▶  RoomId
                          (events/stateToRoom.ts)

RoomId               ──▶  ROOM_ANCHORS ──▶  (col, row) tile
                          (game/rooms.ts)
```

A `Read` event becomes `reading_file` → `library` → an authored
Tiled rect named `Training` or `Library`. If the rect is absent the
loader falls back to a hardcoded anchor in `rooms.ts`.

The full tool/state/room/Tiled-name table lives in
[`hooks-and-rooms.md`](hooks-and-rooms.md).

### Sub-agent linking

Claude's hook payload doesn't tell us "this session is a child of
that one." Agent Force HQ recovers the relationship by timing:

1. When a parent emits `Task` PreToolUse, `hook-provider` pushes a
   `{ at, subagentType }` entry onto the per-parent queue.
2. When a brand-new `session_id` arrives within 60 s, the upsert
   pops one queued entry from the most recent live parent and
   tethers the new NPC via `metadata.parentId`.
3. Parallel `Task` calls each push their own queue entry, so 5
   sub-agents can fire in one turn without all collapsing under
   one parent.
4. Dead parents (whose own session ended before the helper hook
   arrived) are skipped, so we never draw a tether to nobody.

`SubagentStop` removes the helper NPC and emits a synthetic
`agent.subagent.completed` event on the **parent's** stream so the
activity modal shows the handoff.

### Provider seam

The hook provider isn't special — it implements the
`AgentProvider` interface in `src/agents/provider.ts`. The registry
runs N providers in parallel. Adding Cursor (or any other source) is
implementing the interface and registering it once at boot.

`DynamicNpc.provider` carries `"claude" | "claude-master" | "cursor"`
so the roster chip + character-pool hash stay distinct per provider.

---

## 3. The rendering layers

Each NPC is a stack of Phaser game objects sharing one `Entity`
record. From bottom to top:

| Depth   | What it is                                                           |
| ------- | -------------------------------------------------------------------- |
| `0`     | Tile background (drawn from the `.tmj` Background layer)             |
| `5`     | Per-room ambient sprite (📚 ☕ 📺 🧪) — slow yoyo tween               |
| `100`   | Time-of-day tint rectangle (warm dawn → cool night, alpha ≤ 0.32)   |
| `800`   | Empty-state room labels (fade out when first agent arrives)          |
| `900`   | NPC shadow                                                           |
| `950`   | Sub-agent tether dashes (mint, between parent and child)             |
| `951`   | One-shot delegation flash (bright mint pulse on Task spawn)          |
| `1000+` | NPC sprite (offset by `row` so south sprites occlude north ones)     |
| `1500+` | "!" attention indicator                                              |
| `1599+` | HELPER / subagentType badge, transit subtitle, INSTRUCTIONS chip     |
| `1600+` | Overhead pill (compact = emoji only; hover = full name + chip)       |
| `2000`  | Debug overlay (red object rects + green agent anchor dots)           |

Per-frame work in `WorldScene.update()`:

- `tickNpcPaths` — drains the BFS path queue, tweens to next tile.
- `tickChoreoDecay` — auto-stops a tool choreo after 12 s of no new
  activity.
- `tickFollowCamera` — smooth pan when the user "follows" an agent.
- `tickSpriteSeparation` — pushes overlapping sprites apart (visual
  only; doesn't change the canonical `npc.col/npc.row`).
- `tickEmptyStateHints` — fade room labels in/out based on dynamic
  agent count.
- `tickOverheadPills` — keep the pill glued above the sprite, decay
  any in-flight error / prompt flashes.
- `tickTransitBadges` — show "🚶 → Library" while mid-path.
- `tickThinkingBadges` — show 📝 INSTRUCTIONS chip when there's
  fresh thinking text; click opens the Activity modal.
- `drawTethers` — redraw parent↔child dashed lines.
- `drawDebugOverlay` — only when `D` toggled.

---

## 4. The visual vocabulary

Quick reference for "what does that thing above the agent mean?":

| Surface                        | Meaning                                                   |
| ------------------------------ | --------------------------------------------------------- |
| ⌨️ / 📖 / 🖥️ / 🔎 / 🌐 / 🤝 …  | Tool emoji on the pill — what the agent is doing now     |
| 💭 (idle)                      | No tool in flight                                         |
| ❌ (red sprite tint, 2 s)      | Last tool returned an error                              |
| 📨 (~2 s)                      | UserPromptSubmit just fired — the user spoke              |
| ✅                              | Stop hook arrived — turn complete                         |
| 🚶 → Library                   | Currently walking toward that room                        |
| 📝 INSTRUCTIONS (clickable)    | Fresh thinking content; click to open the Activity log    |
| HELPER / RESEARCHER / TESTER   | This NPC is a Task-spawned sub-agent of the parent above  |
| Mint dashed line               | Parent ↔ sub-agent tether                                |
| Bright mint pulse (one-shot)   | The moment of delegation                                  |
| Roster ERROR chip (sticky)     | Agent's most recent tool errored; clears when you open   |
|                                | its Activity modal                                        |

Roster chips:

- **LIVE** (amber) — Claude session you launched from Agent Force HQ
- **EXTERNAL** (grey) — Claude session detected outside the app
- **CURSOR** (purple) — Cursor agent (skeleton; off by default)
- **MASTER** (mint) — master-hive Claude (planned)
- **HELPER** chip on parent — has at least one sub-agent

---

## 5. The map

The world geometry lives in `tiled/dist/fullMap.tmj` (Tiled JSON
export). At app start it's copied to `public/assets/maps/fullMap.tmj`
via `npm run sync:map` (chained into `dev`, `build:web`, `pack`,
`dist`) so editing the .tmj in Tiled and relaunching the app picks
the change up automatically.

Two layers:

- **Background** (tile layer) — the painted floor.
- **Object / Collision** (object layers) — walkable rects, room
  anchors, seats, decoration. Names in this layer route activity
  (e.g. an object named `Training` or `Library` → `library` RoomId).

The tiled-loader normalizes layer offsets so authored object coords
align with the rendered tiles even if the Background layer was
shifted in Tiled.

Press `D` in the running app to see the debug overlay:

- **Red rectangles** around every Tiled object (collision red, seat
  orange-red, decor pink-red).
- **Green dots** at each NPC's `(col, row)` tile-anchor cell — the
  exact coordinate the pathfinder uses.

Use it to confirm a new room rect lines up with the visual desks
before wondering why an agent isn't walking there.

---

## 6. Where to look when something doesn't move

| Symptom                            | First place to look                                                  |
| ---------------------------------- | -------------------------------------------------------------------- |
| New tool doesn't route anywhere    | `toolToState` (`hook-provider.ts`) — falls through to `desk`         |
| Agent goes to wrong room           | `stateToRoom` or the Tiled rect name in `tiled-loader.ts`            |
| Pill emoji is wrong                | `TOOL_EMOJI` / `stateToFace` in `events/stateToRoom.ts`              |
| Agent walks toward a room but stops mid-corridor | DevTools console flood-fill warning — the room is unreachable. Cut a 1-cell gap in the Collision layer between the corridor and the new room. |
| Idle agent vanished                | `HookProvider.sweepIdle` — 10 min total silence evicts               |
| Sub-agent appears as a standalone  | The 60 s spawn window expired before the helper hook arrived, or the parent already ended |
| Hover pill name ≠ roster name      | `pillLabelFor` reads from the live store on each render — refreshing once should fix it |
| Map authored, agents don't appear  | `npm run sync:map` — the `tiled/dist/` source is gitignored; the runtime loads from `public/assets/maps/` |

For a richer cheat sheet (full hook → room table, planned rooms,
Tiled object naming, multi-provider seam) read
[`hooks-and-rooms.md`](hooks-and-rooms.md).

For installing and verifying the hook bridge,
[`install.md`](install.md).

---

## 7. Game SDK (`src/game/sdk/`)

The monolithic `WorldScene.ts` is being decomposed into composable,
event-driven systems under `src/game/sdk/`. Each system handles one
domain and communicates via a typed synchronous event bus.

### Directory layout

```
src/game/sdk/
├── event-bus.ts          — Typed pub/sub (SdkEventMap, emit/on/once)
├── types.ts              — Shared interfaces (ManagedEntity, SystemContext, Direction)
├── GameSdk.ts            — Orchestrator: creates bus + systems, dispatches tick/destroy
├── index.ts              — Barrel exports
└── systems/
    ├── NpcRegistry.ts    — Entity lifecycle, texture resolution, O(1) lookup
    ├── MovementSystem.ts — BFS pathfinding, walk tweens, seat mgmt, desk facing
    ├── ChoreoSystem.ts   — Per-tool animations with 12s auto-decay
    └── InteractionSystem.ts — Click/drag/zoom, NPC hit-test, dialog trigger
```

### Usage

```ts
import { GameSdk } from "./sdk";

// In Phaser scene create():
this.sdk = new GameSdk(this);
this.sdk.init({ seatCells, deskRects, walkableFn });

// In update():
this.sdk.tick(time, delta);

// Move an NPC:
this.sdk.movement.walkToRoom("agent-123", "lounge");

// Play a choreography:
this.sdk.choreo.play("agent-123", "write");

// Query:
this.sdk.registry.get("agent-123");  // ManagedEntity | undefined
this.sdk.movement.isWalking("agent-123");  // boolean
```

### Event bus

Systems communicate via typed events — not direct method calls. This
means new systems can subscribe to existing events without modifying
the emitter. Key event categories:

| Prefix        | Examples                                      | Emitter            |
| ------------- | --------------------------------------------- | ------------------ |
| `npc:`        | `npc:spawned`, `npc:removed`                  | NpcRegistry        |
| `move:`       | `move:started`, `move:arrived`, `move:cancelled` | MovementSystem  |
| `choreo:`     | `choreo:started`, `choreo:stopped`            | ChoreoSystem       |
| `interact:`   | `interact:click`, `interact:hover`, `interact:summon` | InteractionSystem |
| `store:`      | `store:activity`, `store:npc-added`           | WorldScene bridge  |

### Adding a new system

1. Create `src/game/sdk/systems/MySystem.ts`
2. Accept `SystemContext` (scene + bus) and `NpcRegistry` in the constructor
3. Subscribe to relevant bus events
4. Emit your own events for downstream consumers
5. Export from `src/game/sdk/index.ts`
6. Instantiate in `GameSdk.ts` constructor, wire `tick()` if needed

### Migration strategy

The SDK is additive — `WorldScene.ts` still works unchanged. Systems
are wired incrementally: each `walkNpcToRoom` call in WorldScene can
be replaced with `this.sdk.movement.walkToRoom(...)` one at a time.
Once all calls delegate to the SDK, the private methods in WorldScene
can be deleted.
