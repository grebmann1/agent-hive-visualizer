# Hooks → Rooms → Movement

This doc is the cheat sheet for everyone working on Agent Force HQ.
It covers:

- The pipeline from a Claude CLI hook to a sprite walking on the map
- The current tool / state / room mapping
- Hooks we DON'T yet consume and what they could become
- Rooms we already have and rooms we plan to add
- The multi-provider seam that lets us add Cursor / master-hive
  agents in the future without rewriting the world

Use it when adding a new tool, renaming a room, or debugging "why
didn't the agent walk?".

---

## 1. Pipeline

```
Claude CLI hook   (PreToolUse, PostToolUse, Stop, …)
  → ~/.agentquest/bin/post-hook.sh           POST 127.0.0.1:47329/hook
  → electron/hook-server.js                  validate loopback, parse JSON
  → IPC "claude:hook"                         electron/preload.js
  → src/agents/hook-provider.ts              HookProvider.handle
        - upsertAgent on first event for a session
        - toolToState() → AgentState
        - emit AgentEvent → useAgentStore
  → src/game/WorldScene.subscribeStores      pulls AgentEvent
        - look up event → VisualAction (via stateToRoom)
        - walkNpcToRoom(agentId, action.room)
        - startChoreoFor(agent, action.choreo)
  → BFS path on tile grid                    src/game/pathfind.ts
  → tweened sprite movement                  WorldScene.tickNpcPaths
        - last step lands on tile center, OR
          on the seat's pixel center (when finalOffset is set)
```

Two background loops live alongside this pipeline:

- **Idle-sit loop** (`WorldScene.cinemaTick`, every 2 s — name is
  legacy) — any NPC with no real activity for 60 s walks to a free
  `Seat` object (any desk seat anywhere on the map) and sits. There
  is no dedicated "lounge" room any more; idle = sitting at a desk.
  Local to the renderer, no hook involvement.
- **Idle eviction** (`hook-provider.ts:sweepIdle`, every 30 s) —
  any NPC with no hook events for 10 min is REMOVED from the world.
  This is the reason long-idle external sessions disappear.

---

## 2. Current tool → state → room mapping

`toolToState` is in `src/agents/hook-provider.ts:157`.
`stateToRoom` is in `src/events/stateToRoom.ts:3`.

| Hook `tool_name` | AgentState         | RoomId           | Tiled object names              |
| ---------------- | ------------------ | ---------------- | ------------------------------- |
| `Read`           | `reading_file`     | `library`        | Training, Library               |
| `Grep`, `Glob`   | `searching`        | `library`        | Training, Library               |
| `WebFetch`       | `searching`        | `library`        | Training, Library               |
| `WebSearch`      | `searching`        | `library`        | Training, Library               |
| `Edit`           | `coding`           | `coding_room`    | DevOps, Workshop                |
| `Write`          | `coding`           | `coding_room`    | DevOps, Workshop                |
| `MultiEdit`      | `coding`           | `coding_room`    | DevOps, Workshop                |
| `NotebookEdit`   | `coding`           | `coding_room`    | DevOps, Workshop                |
| `Bash`           | `calling_tool`     | `tool_workshop`  | WarRoom, Kitchen                |
| `TodoWrite`      | `planning`         | `desk`           | DataCenter, "Control Room", Ops |
| `Task`           | `talking_to_agent` | `meeting_room`   | "Meeting Room", Meeting         |
| (anything else)  | `thinking`         | `desk`           | DataCenter, …                   |

State-only mappings (no tool, fired by state-change events):

| AgentState         | Room            | Why                       |
| ------------------ | --------------- | ------------------------- |
| `idle`             | `desk`          | Sit at a desk seat        |
| `waiting_for_user` | `desk`          | Sit at a desk seat        |
| `completed`        | `desk`          | Sit at a desk seat        |
| `running_tests`    | `testing_lab`   | Security, "Test Rig"      |
| `debugging`        | `coding_room`   | DevOps                    |
| `deploying`        | `tool_workshop` | WarRoom                   |
| `summarizing`      | `desk`          | DataCenter                |
| `failed`           | `desk`          | DataCenter (slumps over)  |
| `thinking`         | `desk`          | DataCenter                |
| `planning`         | `desk`          | DataCenter                |

`RoomId` is in `src/events/types.ts`. Today's six rooms (the old
`cinema` / Lounge has been removed — idle agents sit at any free
desk seat instead):
`library`, `desk`, `coding_room`, `testing_lab`, `tool_workshop`,
`meeting_room`.

---

## 3. Hook coverage

Each row is a free real-estate signal — some already wired, others
still on the backlog.

| Claude hook            | Status   | Notes                                                                                           |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `UserPromptSubmit`     | ✅ wired (Stage A2) | Flashes a 📨 above the agent for ~2 s and resets the idle timer so the agent doesn't drift away mid-conversation. |
| `PostToolUseFailure`   | ✅ wired (Stage A1) | Sticky `ERROR` chip in the roster + 2 s red sprite tint + ❌ pill flash. |
| `SubagentStop`         | ✅ wired (Stage A3) | Despawns only the helper sprite; the parent Claude session keeps running. |
| `Notification`         | ignored  | Claude wants attention. Future home: **Reception**, ring a 🔔.                                  |
| `PermissionRequest`    | ignored  | Tool blocked. Future home: **Security Checkpoint** with 🚧.                                     |
| `PreCompact`           | ignored  | Context about to shrink. Future home: **Archive** (filing cabinets) with 🗄️.                   |
| `PostCompact`          | ignored  | Compaction done. Brief "phew" pose, then resume the previous room.                              |
| `SessionEnd`           | infers via monitor death | Listen explicitly so the walk-out can begin BEFORE the process dies.                |

To wire a new hook, see "Where to add a new tool / hook" below.

---

## 4. Planned rooms (author in Tiled when ready)

You don't need to add these all at once. Each ships when its
matching hook handler is ready in the renderer.

| RoomId         | Display name        | What it visualizes                            | Tiled name suggestions   |
| -------------- | ------------------- | --------------------------------------------- | ------------------------ |
| `reception`    | Reception           | UserPromptSubmit + Notification               | `Reception`, `FrontDesk` |
| `archive`      | Archive             | PreCompact / PostCompact                      | `Archive`, `Filing`      |
| `checkpoint`   | Security Checkpoint | PermissionRequest                             | `Checkpoint`, `SecurityGate` |
| `comms`        | Comms Room          | WebFetch / WebSearch (split from Library)     | `Comms`, `Communications` |
| `server_room`  | Server Room         | Bash (split from WarRoom)                     | `ServerRoom`, `Servers`  |
| `bug_lab`      | Bug Lab             | `debugging` state (split from coding_room)    | `BugLab`, `Triage`       |
| `executive`    | Executive Office    | Future master-hive agent's home               | `Executive`, `BossRoom`  |

Each new RoomId requires three things to come online:

1. Add it to the `RoomId` union in `src/events/types.ts`.
2. Add a `Tiled-name → RoomId` entry to
   `src/game/tiled-loader.ts:164 ROOM_NAME_TO_ID`.
3. Add a fallback anchor in `src/game/rooms.ts FALLBACK_ANCHORS` so
   the world still loads if the .tmj rect is missing.

(And of course — author the rect in `tiled/dist/fullMap.tmj`, add a
1-cell gap in the Collision layer connecting it to the corridor.
The reachability flood-fill warns at boot for unreachable rooms.)

---

## 5. Tile-side: Tiled object names — authoritative reference

This is the list of object **names** the renderer recognizes when
parsing `tiled/dist/fullMap.tmj`. **Names are case-insensitive** —
`Training` / `training` / `TRAINING` all match. **First object that
claims a RoomId wins**; duplicates render as decor only.

Source of truth: `src/game/tiled-loader.ts:164 ROOM_NAME_TO_ID`.
If you need a name that's not in the list below, either:
(a) rename your rect to a recognized name, or
(b) add a new mapping in `ROOM_NAME_TO_ID` and ship the change.

### 5.1 Existing rooms (already wired)

| Tiled object name (any of) | RoomId          | Routes which tools / states                 |
| -------------------------- | --------------- | ------------------------------------------- |
| `Training`, `Library`      | `library`       | `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, state `reading_file`, `searching` |
| `DataCenter`, `Control Room`, `Ops` | `desk`   | `TodoWrite`, default fallback, states `thinking`, `planning`, `summarizing`, `failed`, `idle`, `waiting_for_user`, `completed` |
| `DevOps`, `Workshop`       | `coding_room`   | `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, state `coding`, `debugging` |
| `WarRoom`, `War Room`, `Kitchen` | `tool_workshop` | `Bash`, state `calling_tool`, `deploying` |
| `Security`, `Test Rig`     | `testing_lab`   | state `running_tests`                       |
| `Meeting Room`, `Meeting`  | `meeting_room`  | `Task` (sub-agent spawn), state `talking_to_agent` |

### 5.2 Planned rooms (add when you're ready)

These RoomIds are not yet in the code. To bring one online, author
the Tiled rect with one of the names below AND make the matching
edit to `RoomId` / `ROOM_NAME_TO_ID` / `stateToRoom` /
`FALLBACK_ANCHORS`. (Roadmap details in
`/Users/grebmann/.claude/plans/perfect-all-set-now-shimmering-finch.md`.)

| Tiled name (any of)        | Future RoomId   | Will route                                  |
| -------------------------- | --------------- | ------------------------------------------- |
| `Reception`, `FrontDesk`   | `reception`     | `UserPromptSubmit`, `Notification`          |
| `Checkpoint`, `SecurityGate` | `checkpoint`  | `PermissionRequest`                         |
| `Archive`, `Filing`        | `archive`       | `PreCompact`, `PostCompact`                 |
| `Comms`, `Communications`  | `comms`         | `WebFetch`, `WebSearch` (split from library) |
| `ServerRoom`, `Servers`    | `server_room`   | `Bash` (split from tool_workshop)           |
| `BugLab`, `Triage`         | `bug_lab`       | state `debugging` (split from coding_room)  |
| `Executive`, `BossRoom`    | `executive`     | future master-hive Claude home              |

### 5.3 Special objects (NOT rooms)

These are individual object names — not room rects — handled
separately by the loader.

| Tiled object name | Property                | Effect |
| ----------------- | ----------------------- | ------ |
| `Start`           | —                       | Exterior spawn rect for new dynamic NPCs. First object named `Start` wins. The renderer picks a walkable cell inside it. |
| `Seat`, or any name with custom property `seat: true` (boolean) | `seat: true` | Sit cells. The agent sits on the rect's **pixel center**, not the tile center. Each seat can hold one agent at a time; idle agents auto-claim a free seat after 60 s of inactivity. |
| `Desk`            | —                       | Decor only today; reserved for a future "highlight desk in use" feature. The seat next to a Desk is what an agent actually occupies. |

### 5.4 Authoring tips

- After adding a new room rect, **cut a 1-cell gap in the
  `Collision` layer** between the corridor and the new room.
  Otherwise the BFS pathfinder treats the room as unreachable, and
  the renderer logs a warning at boot listing exactly which rooms
  agents can't get into.
- Names with spaces are fine — `War Room`, `Meeting Room`. The
  matcher lowercases before comparison.
- A rect named with a non-recognized string (e.g. `Decoration`)
  is silently ignored — no error, no warning. So a typo in a room
  name will look like "the room exists but no agent ever goes
  there". Double-check spelling.
- `collidable: true` and `seat: true` are the two custom properties
  the loader reads; everything else on an object is metadata you
  can use however you like.

---

## 6. Emoji on the overhead pill

`TOOL_EMOJI` (`src/events/stateToRoom.ts:45`) wins over `stateToFace`
(`stateToRoom.ts:24`). The pill renders the tool emoji while a tool
is in-flight (PreToolUse → PostToolUse window) and falls back to the
state emoji once the tool completes.

- `IDLE_EMOJI = 💭`
- `ERROR_EMOJI = ❌`
- `COMPLETED_EMOJI = ✅`

When you wire a new hook, decide whether it gets a unique emoji or
inherits from the resulting state.

---

## 7. Multi-provider future

The hook flow above is provider-agnostic. The seam:

- `src/agents/provider.ts` defines the `AgentProvider` interface
  (`upsertAgent`, `removeAgent`, `emitEvent`).
- `src/agents/registry.ts` runs N providers in parallel; each gets
  its own narrow API and starts/stops on a refcount.
- `src/agents/hook-provider.ts` is the only provider today.

To add a second provider you implement the interface, register it
once at boot, and emit `AgentEvent`s with the same shape the world
already understands. The store deduplicates by agent id so two
providers can coexist without conflict.

### Cursor agents (planned)

Cursor publishes its own activity surface (file changes, AI panel
state). A `CursorProvider` would:

- Listen on Cursor's IPC / file-watcher / CLI feed.
- Translate to `AgentEvent` (`agent.tool.called`, `agent.file.edited`,
  …) — the same vocabulary the hook provider uses.
- `upsertAgent` with `metadata.provider = "cursor"` so the renderer
  can pick a distinct sprite pool / pill color.

Visual differentiation knobs already in place:

- `MODERN_CHARS` — reserve some characters for Cursor (e.g. Amelia)
  by hashing on `(provider + id)` instead of just `id`.
- `DynamicNpc.external` — already used for non-AgentQuest sessions;
  generalize to a `provider` field with values `claude` | `cursor`.
- Roster pill colors — the chip in `AgentRoster.tsx` reads `external`
  to render an "EXT" badge today; add a "CRSR" badge for Cursor.

### Master-hive Claude (planned, longer term)

A "master" claude that orchestrates a team of sub-claudes. Mechanically
identical to today's `Task` tool spawning a sub-agent — just persistent
and many-to-one. Plumbing reuse:

- `DynamicNpc.parentId` already exists.
- `WorldScene.tetherGfx` already draws parent↔child tethers.
- `ROOM_NAME_TO_ID` would gain an `executive` entry; the master
  spawns there instead of the `Start` rect.

The new piece would be **persistent group lifetime**: today sub-agents
disappear when the parent's `Task` PostToolUse fires. The master-hive
case wants the team to outlive any single tool call. That's a state
on the parent (`parent.teamSize`) plus a tweak to `removeNpcEntity`
to NOT despawn parented NPCs while the parent is alive.

---

## 8. Where to add a new tool / hook

1. Add the `tool_name` to the switch in
   `src/agents/hook-provider.ts:165 toolToState`. Decide which
   existing `AgentState` (and so which room) it should produce.
2. If you also want a unique pill emoji, add an entry to `TOOL_EMOJI`
   in `src/events/stateToRoom.ts:45`.
3. If the hook ISN'T a tool (Notification, PreCompact, etc.), add a
   new `case` to `HookProvider.handle` in `hook-provider.ts` that
   emits an appropriate `AgentEvent` (e.g. `agent.state.changed` with
   a state of your choice). The `stateToRoom` lookup will route it.
4. If you want a brand-new room, follow §4 — add the RoomId, the
   Tiled name mapping, the fallback anchor, and author the rect.

---

## 9. Where to look when something doesn't move

| Symptom                           | First place to look                                                |
| --------------------------------- | ------------------------------------------------------------------ |
| New tool doesn't route anywhere   | `toolToState` (hook-provider.ts) — falls through to `desk`         |
| Agent goes to wrong room          | `stateToRoom` (stateToRoom.ts) or the Tiled rect name              |
| Pill emoji is wrong               | `TOOL_EMOJI` / `stateToFace` in stateToRoom.ts                     |
| Agent walks toward a room but stops mid-corridor | Collision-layer wall in Tiled — DevTools console flood-fill warning lists unreachable rooms |
| Idle agent vanished               | 10-min sweeper in `hook-provider.ts:464`                           |
| Agent stands beside the seat instead of on it | `SeatCell.px/py` not propagated; check `walkNpcToCell` got the offset arg |
| Empty space below map / map cropped | Camera viewport not resized — `fitZoom` calls `cam.setSize` on resize |
