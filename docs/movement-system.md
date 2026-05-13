# Movement System Architecture

## Overview

The movement system is the core agentic movement solution for the 2D agent visualization. It guarantees that **agents always walk** — no teleporting, ever — and provides a declarative rule engine for customizing routes without code changes.

---

## System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        TRIGGERS                                  │
│  useAgentStore (tool events)  │  WorldBus (summon)  │  IdleSit  │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       │  walkNpcToRoom(id, room)
                       │  walkNpcToCell(id, col, row)
                       v
┌─────────────────────────────────────────────────────────────────┐
│                   MovementDirector                                │
│                                                                   │
│  Single public API for all movement intents.                      │
│                                                                   │
│  1. Builds a MoveIntent from the caller's request                │
│  2. Finds a walkable target cell near the room anchor            │
│  3. Creates a base Leg (single destination)                      │
│  4. Passes it through the RouteRuleEngine                        │
│  5. Hands the resulting MovementPlan to the Executor             │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       │  ruleEngine.process(intent, ctx, baseLeg)
                       v
┌─────────────────────────────────────────────────────────────────┐
│                   RouteRuleEngine                                 │
│                                                                   │
│  Pure middleware pipeline — no Phaser, no side effects.           │
│                                                                   │
│  For each rule (sorted by priority, highest first):              │
│    if rule.matches(intent, context) → legs = rule.apply(legs)    │
│                                                                   │
│  Input:  [Leg(target=desk)]                                      │
│  Output: [Leg(coffee, dwell=2s), Leg(target=desk)]               │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       │  executor.enqueuePlan(plan)
                       v
┌─────────────────────────────────────────────────────────────────┐
│                   MovementExecutor                                │
│                                                                   │
│  The SOLE code that moves sprites. Nothing else touches          │
│  sprite positions after initial spawn.                           │
│                                                                   │
│  Per frame (tick):                                               │
│    • Process legs sequentially                                   │
│    • BFS pathfind to current leg's target                        │
│    • Tween sprite one tile per step (180ms)                      │
│    • On leg arrival → dwell timer → next leg                     │
│    • On BFS failure → retry (up to 5×), never teleport           │
│                                                                   │
│  Emits: move:started, move:step, move:arrived, move:blocked      │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────────────────────┐
│                     SeatManager                                   │
│                                                                   │
│  Claim / release / query seats.                                  │
│  Provides pixel offsets and desk-facing orientation.             │
│  Decoupled from Phaser — pure data manager.                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Example: Agent Leaves Lounge → Desk

```
1. Store emits activity: agent "claude-1" got a tool_call (Edit)
2. WorldScene.subscribeStores fires → walkNpcToRoom("claude-1", "desk")
3. Director builds intent:
     { kind: "room", npcId: "claude-1", room: "desk",
       context: { sourceRoom: "lounge" } }

4. Director builds base leg:
     [{ target: {col:20, row:3}, dwellMs: 0, room: "desk" }]

5. RouteRuleEngine matches rules (priority order):
     ✗ unreachable-room-fallback (priority 100) — desk IS reachable
     ✓ coffee-stop-lounge-to-work (priority 10)  — leaving lounge!

6. Rule prepends a coffee waypoint:
     [
       { target: {col:22, row:14}, dwellMs: 2000, room: "lounge", tag: "coffee-stop" },
       { target: {col:20, row:3},  dwellMs: 0,    room: "desk" }
     ]

7. Executor receives the 2-leg plan:
     Leg 1: BFS to (22,14) → walk → arrive → dwell 2000ms
     Leg 2: BFS to (20,3)  → walk → arrive → idle pose

8. Agent walks to coffee bar, pauses 2 seconds, then walks to desk.
   Total: always walking, never teleporting.
```

---

## Route Rules

Rules live in `src/game/movement/route-rules.ts` as a flat array. Each rule is a plain object:

```typescript
interface RouteRule {
  id: string;                    // unique identifier
  priority: number;              // higher = runs first
  matches: (intent, ctx) => boolean;   // should this rule fire?
  apply: (legs, intent, ctx) => Leg[]; // transform the route
}
```

### Currently Active Rules

| Rule | Priority | When it fires | What it does |
|------|----------|---------------|--------------|
| `unreachable-room-fallback` | 100 | Target room has no path from entry | Reroutes to nearest reachable room |
| `coffee-stop-lounge-to-work` | 10 | Agent is in lounge AND going to any work room | Prepends a 2s stop at the coffee station |

### Adding a New Rule

To add a rule like "agents wave when passing the meeting room":

```typescript
// In src/game/movement/route-rules.ts, add to ROUTE_RULES array:

{
  id: "wave-at-meeting-room",
  priority: 5,
  matches: (intent, ctx) => {
    // Only fire when passing through the meeting room corridor
    if (intent.kind !== "room") return false;
    const meetingRegion = ctx.getRoomRegions().find(r => r.id === "meeting_room");
    if (!meetingRegion) return false;
    // Check if the agent is currently near the meeting room
    const { col, row } = ctx.npcCurrentCell;
    return col >= meetingRegion.colMin - 2 && col <= meetingRegion.colMax + 2
        && row >= meetingRegion.rowMin && row <= meetingRegion.rowMax;
  },
  apply: (legs, _intent, ctx) => {
    const meetingAnchor = ctx.roomAnchors["meeting_room"];
    if (!meetingAnchor) return legs;
    return [
      {
        target: { col: meetingAnchor.col - 1, row: meetingAnchor.row },
        dwellMs: 1000,
        tag: "wave",  // WorldScene can listen for this tag
      },
      ...legs,
    ];
  },
},
```

No other files need changes. The engine picks it up automatically.

---

## Context Available to Rules

```typescript
interface RouteRuleContext {
  npcCurrentRoom: RoomId | null;        // which room the agent is in now
  npcCurrentCell: { col, row };         // exact tile position
  roomAnchors: Record<RoomId, Cell>;    // center of each room
  isReachable: (room) => boolean;       // can BFS reach this room?
  isWalkable: (col, row) => boolean;    // is this tile walkable?
  getRoomRegions: () => Region[];       // spatial bounds of all rooms
}
```

---

## Key Guarantees

| Guarantee | How it's enforced |
|-----------|-------------------|
| **No teleporting** | MovementExecutor is the sole sprite mover. BFS failure → retry, never setPosition. |
| **Always walk** | Even "already at cell" cases use a tween slide (not snap) for the seat offset. |
| **Rules are composable** | Multiple rules can match the same intent — they chain (highest priority first). |
| **Rules are pure** | No Phaser dependency, no side effects — testable with plain objects. |
| **Extensible without code changes** | Add an object to the array. The engine, executor, and director don't change. |

---

## File Map

```
src/game/movement/
├── index.ts                 — barrel exports
├── types.ts                 — Leg, MovementPlan, MoveIntent (discriminated union)
├── route-rules.ts           — ROUTE_RULES array (add your rules here)
├── route-rule-engine.ts     — engine that applies matching rules
├── movement-director.ts     — single public API (moveToRoom, moveToCell, moveToSeat)
├── movement-executor.ts     — sole sprite mover (BFS + tweens + multi-leg + dwell)
└── seat-manager.ts          — seat claim/release/facing logic
```

---

## Anti-Teleport Safety Net

```
                    BFS returns empty path?
                           │
                    ┌──────┴──────┐
                    │             │
                  YES            NO
                    │             │
            retry++ < 5?     Walk normally
                    │
              ┌─────┴─────┐
              │           │
            YES          NO
              │           │
        Wait 600ms    Emit "blocked"
        Try again     Agent stays put
              │
              └──→ Never teleport
```

The executor will **never** call `sprite.setPosition()` except at initial spawn. If a path can't be found after 5 retries (3 seconds), the agent stays where it is and emits a `move:blocked` event. This is the structural guarantee against teleporting.
