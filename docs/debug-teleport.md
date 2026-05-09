# Diagnosing teleporting agents

When an NPC appears to "teleport" — jump across the canvas without
walking the corridor between two points — it usually means one of:

1. A `setPosition` call wrote a destination that wasn't the next
   walkable tile (e.g. a re-route after the path was already
   tweening).
2. The sprite-separation tick pushed the sprite outside the
   `MAX_OFFSET_SQ` cap.
3. A seat snap (`walkNpcToCell` "already there" branch) fired with
   a stale `npcSeatOffset`.
4. The hover scale or a choreo modified `sprite.x/sprite.y` (it
   shouldn't — choreos avoid x/y, but sit-down's settle does).

The agent motion log captures every event that mutates an NPC's
sprite position so you can replay it and spot the offending step.

---

## Capture a log

The motion log is **off by default** — it doesn't allocate when
disabled, so leaving it off costs nothing. Turn it on only while
you're actively chasing a bug.

1. Open Agent Force HQ.
2. Click the **🐞 DEBUG** chip in the top-right corner of the
   canvas (or press **Shift+D**).
3. Toggle **AGENT MOTION LOG** to ON. The chip turns into 🔴 LOG
   to remind you recording is live.
4. Reproduce the teleport (run a real `claude` session, watch
   until the agent jumps).
5. Open the debug panel again and click **▼ EXPORT JSON**, OR
   press **Shift+E** anywhere outside an input field.
6. Browser saves `agent-log-<ISO-timestamp>.json` to your
   Downloads folder.
7. Toggle the log OFF afterward; the buffer is freed.

The setting persists across reloads (stored in localStorage), so
if you forget it stays on, the chip will keep showing 🔴 to remind
you.

You can also drive the log from DevTools:

```js
window.agentLog.setEnabled(true)
window.agentLog.size()      // current entry count
window.agentLog.snapshot()  // returns the array directly
window.agentLog.download()
window.agentLog.clear()
window.agentLog.setEnabled(false)
```

---

## Entry shape

Each entry:

```ts
{
  ts: number,        // Date.now()
  scene: number,     // ms since the scene booted
  agentId: string,
  kind: AgentLogKind,
  fromCol?: number,  // tile-space before
  fromRow?: number,
  toCol?: number,    // tile-space after
  toRow?: number,
  fromX?: number,    // pixel-space before
  fromY?: number,
  toX?: number,      // pixel-space after
  toY?: number,
  note?: string      // optional human-readable context
}
```

`AgentLogKind` values:

| kind | What it means |
| ---- | ------------- |
| `spawn` | NPC just appeared |
| `remove` | NPC about to be removed |
| `walk-step-start` | Per-tile walk tween kicked off |
| `walk-step-end` | Tween completed; col/row committed |
| `walk-step-skip` | Path step blocked, retrying next tick |
| `seat-snap` | Sprite snapped to a seat's authored pixel center |
| `separation` | tickSpriteSeparation pushed the sprite |
| `summon` | walkNpcToRoom was called with a target |
| `helper-spawn` / `helper-despawn` | Floating helper sprite |
| `hover-scale` | Pointer hover/leave scaled the sprite |
| `choreo-start` / `choreo-stop` | Choreography started or stopped |
| `texture-swap` | sprite.setTexture (sit pose ↔ run pose) |
| `warn` | Anomaly detected at runtime |

---

## Spotting a teleport

Open the JSON in your editor and look for two consecutive entries
on the same `agentId` where:

- The pixel delta is bigger than one tile (32 px), AND
- The intermediate kind is NOT `walk-step-start`/`walk-step-end`
  (those are legitimate per-tile steps).

A quick `jq` recipe:

```bash
jq -r '
  def diff:
    (.toX // .fromX) as $tx
    | (.toY // .fromY) as $ty
    | $tx + " " + $ty + " " + .agentId + " " + .kind;
  group_by(.agentId)
  | .[]
  | sort_by(.scene)
  | . as $list
  | range(1; length) as $i
  | ($list[$i-1]) as $prev
  | ($list[$i]) as $curr
  | (($curr.toX // $curr.fromX) - ($prev.toX // $prev.fromX)) as $dx
  | (($curr.toY // $curr.fromY) - ($prev.toY // $prev.fromY)) as $dy
  | (($dx*$dx + $dy*$dy) | sqrt) as $dist
  | select($dist > 32)
  | "agent=\($curr.agentId) Δpx=\($dist | floor) prev=\($prev.kind) curr=\($curr.kind) note=\($curr.note // \"-\")"
' agent-log-*.json | head -20
```

That prints every >1-tile jump with its preceding event — the
teleport's caller is usually right there.

---

## Common causes (and where they live in the code)

| Symptom                                     | Likely cause                                              | Code path                          |
| ------------------------------------------- | --------------------------------------------------------- | ---------------------------------- |
| Agent appears at the wrong room anchor      | `walkNpcToRoom` deep-room fallback chose a far cell       | `WorldScene.walkNpcToRoom`         |
| Seated agent reappears across the room      | `seat-snap` after a stale `npcSeatOffset`                 | `WorldScene.walkNpcToCell` (path<=1)|
| Cluster of agents jitter apart              | `tickSpriteSeparation` push, capped at `MAX_OFFSET_SQ=14` | `WorldScene.tickSpriteSeparation`  |
| Agent jumps mid-walk to next room           | A new activity event triggered another `walkNpcToRoom`    | `subscribeStores`                  |
| Sub-agent spawns far from parent            | `addNpcEntity` parentId fallback to home anchor           | `WorldScene.addNpcEntity`          |

---

## Adding more taps

When you find a missing instrumentation site, add a `logAgent`
call alongside the existing ones in `src/game/WorldScene.ts`. The
helper signature is:

```ts
logAgent({
  ts: Date.now(),
  scene: this.time.now,
  agentId,
  kind: "warn",          // pick the closest enum value
  fromX, fromY, toX, toY, // include whichever apply
  note: "what happened",
});
```

If a new event class is needed (not just `warn`), add it to
`AgentLogKind` in `src/game/agentLog.ts` and update this doc's
table.
