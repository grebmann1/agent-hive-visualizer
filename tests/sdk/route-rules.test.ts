import { describe, it, expect, vi, beforeEach } from "vitest";
import { MovementSystem } from "../../src/game/sdk/systems/MovementSystem";
import { RouteRuleEngine } from "../../src/game/sdk/systems/RouteRuleEngine";
import { ROUTE_RULES } from "../../src/game/sdk/systems/route-rules";
import { createEventBus } from "../../src/game/sdk/event-bus";
import type { EventBus } from "../../src/game/sdk/event-bus";
import type { ManagedEntity, SystemContext, Leg } from "../../src/game/sdk/types";
import type { SeatCell } from "../../src/game/tiled-loader";

// ---------------------------------------------------------------------------
// Mock zones + rooms + pathfind so MovementSystem can be exercised in isolation
// ---------------------------------------------------------------------------

vi.mock("../../src/game/rooms", () => {
  return {
    ROOM_ANCHORS: {
      lounge: { col: 7, row: 7 },
      desk: { col: 2, row: 2 },
      meeting_room: { col: 4, row: 4 },
      library: { col: 1, row: 1 },
      // Anchor exists but isRoomReachable() will mark it unreachable so
      // the fallback rule has a chance to fire.
      tool_workshop: { col: 8, row: 1 },
    },
    getRoomRegions: () => [
      { id: "lounge", colMin: 6, colMax: 9, rowMin: 6, rowMax: 9 },
      { id: "desk", colMin: 1, colMax: 3, rowMin: 1, rowMax: 3 },
      { id: "meeting_room", colMin: 3, colMax: 5, rowMin: 3, rowMax: 5 },
    ],
    roomIdForCell: (col: number, _row: number) => {
      // Anything in cols 6-9 reads as "lounge" so we can plant agents there.
      if (col >= 6) return "lounge";
      return null;
    },
  };
});

vi.mock("../../src/game/zones", () => {
  return {
    isRoomReachable: vi.fn((room: string) => room !== "tool_workshop"),
  };
});

vi.mock("../../src/game/pathfind", () => {
  function bfs(
    sc: number,
    sr: number,
    tc: number,
    tr: number,
  ): Array<{ col: number; row: number }> {
    if (sc === tc && sr === tr) return [{ col: sc, row: sr }];
    // 1-step path so legs advance one tween at a time.
    return [
      { col: sc, row: sr },
      { col: tc, row: tr },
    ];
  }
  return { bfs };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockScene() {
  return {
    tweens: {
      add: vi.fn(() => ({ destroy: vi.fn() })),
      killTweensOf: vi.fn(),
    },
    time: { now: 0, delayedCall: vi.fn() },
  } as any;
}

function mockRegistry() {
  const entities = new Map<string, ManagedEntity>();
  return {
    get: (id: string) => entities.get(id),
    has: (id: string) => entities.has(id),
    forEach: (fn: (entity: ManagedEntity, id: string) => void) =>
      entities.forEach((e, id) => fn(e, id)),
    count: () => entities.size,
    sheetKeyFor: (_id: string) => "modern_adam",
    idleKeyFor: (_id: string) => "modern_adam_idle",
    _add: (id: string, entity: ManagedEntity) => entities.set(id, entity),
  } as any;
}

function mockEntity(id: string, col: number, row: number): ManagedEntity {
  return {
    state: {
      id,
      def: { id, name: id } as any,
      col,
      row,
      facing: "down" as const,
      restingScale: 1,
      isSubAgent: false,
    },
    visuals: {
      sprite: {
        x: col * 32 + 16,
        y: row * 32 + 16,
        scene: {},
        play: vi.fn(),
        stop: vi.fn(),
        setTexture: vi.fn(),
        setPosition: vi.fn(),
        setDepth: vi.fn(),
        texture: { key: "modern_adam" },
      } as any,
      shadow: {
        x: col * 32 + 16,
        y: row * 32 + 16 + 7,
        setPosition: vi.fn(),
      } as any,
      tween: undefined,
    },
    overlays: {},
  } as ManagedEntity;
}

function getActivePlanLegs(system: MovementSystem, id: string): Leg[] | null {
  const state = (system as any).active.get(id);
  return state ? state.plan.legs : null;
}

// ---------------------------------------------------------------------------
// RouteRuleEngine — unit
// ---------------------------------------------------------------------------

describe("RouteRuleEngine", () => {
  it("processes rules in priority order (highest first)", () => {
    const calls: string[] = [];
    const engine = new RouteRuleEngine([
      {
        id: "low",
        priority: 1,
        matches: () => true,
        apply: (legs) => {
          calls.push("low");
          return legs;
        },
      },
      {
        id: "high",
        priority: 100,
        matches: () => true,
        apply: (legs) => {
          calls.push("high");
          return legs;
        },
      },
    ]);
    engine.process(
      { npcId: "x", kind: "room", room: "lounge" },
      {} as any,
      [{ target: { col: 0, row: 0 }, dwellMs: 0 }],
    );
    expect(calls).toEqual(["high", "low"]);
  });

  it("skips rules whose matches() returns false", () => {
    const engine = new RouteRuleEngine([
      {
        id: "skip",
        priority: 1,
        matches: () => false,
        apply: () => [{ target: { col: 99, row: 99 }, dwellMs: 0 }],
      },
    ]);
    const out = engine.process(
      { npcId: "x", kind: "room", room: "lounge" },
      {} as any,
      [{ target: { col: 0, row: 0 }, dwellMs: 0 }],
    );
    expect(out).toEqual([{ target: { col: 0, row: 0 }, dwellMs: 0 }]);
  });

  it("addRule keeps the priority order invariant", () => {
    const engine = new RouteRuleEngine([]);
    const calls: string[] = [];
    engine.addRule({ id: "a", priority: 5, matches: () => true, apply: (l) => (calls.push("a"), l) });
    engine.addRule({ id: "b", priority: 50, matches: () => true, apply: (l) => (calls.push("b"), l) });
    engine.addRule({ id: "c", priority: 10, matches: () => true, apply: (l) => (calls.push("c"), l) });
    engine.process(
      { npcId: "x", kind: "room", room: "lounge" },
      {} as any,
      [{ target: { col: 0, row: 0 }, dwellMs: 0 }],
    );
    expect(calls).toEqual(["b", "c", "a"]);
  });

  it("removeRule drops the rule by id", () => {
    const calls: string[] = [];
    const engine = new RouteRuleEngine([
      { id: "drop-me", priority: 10, matches: () => true, apply: (l) => (calls.push("drop"), l) },
    ]);
    engine.removeRule("drop-me");
    engine.process(
      { npcId: "x", kind: "room", room: "lounge" },
      {} as any,
      [{ target: { col: 0, row: 0 }, dwellMs: 0 }],
    );
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MovementSystem.walkToRoom — coffee-stop rule
// ---------------------------------------------------------------------------

describe("MovementSystem — coffee-stop-lounge-to-work rule", () => {
  let bus: EventBus;
  let system: MovementSystem;
  let registry: ReturnType<typeof mockRegistry>;

  beforeEach(() => {
    bus = createEventBus();
    const ctx: SystemContext = { scene: mockScene(), bus };
    registry = mockRegistry();
    system = new MovementSystem(ctx, registry);
    system.init([] as SeatCell[], [], () => true);
  });

  it("inserts a 2 s lounge dwell when leaving the lounge for desk", () => {
    // Place agent in the lounge so roomIdForCell returns "lounge".
    const entity = mockEntity("agent-1", 7, 7);
    registry._add("agent-1", entity);

    system.walkToRoom("agent-1", "desk");

    const legs = getActivePlanLegs(system, "agent-1");
    expect(legs).not.toBeNull();
    expect(legs!.length).toBe(2);
    expect(legs![0].room).toBe("lounge");
    expect(legs![0].tag).toBe("coffee-stop");
    expect(legs![0].dwellMs).toBe(2000);
    // Coffee-stop tile is anchored at lounge.col + 2, row.
    expect(legs![0].target).toEqual({ col: 9, row: 7 });
    // Final leg is the original "go to desk" target.
    expect(legs![1].room).toBe("desk");
    expect(legs![1].dwellMs).toBe(0);
  });

  it("does NOT insert a dwell when going from lounge → lounge", () => {
    const entity = mockEntity("agent-1", 7, 7);
    registry._add("agent-1", entity);

    system.walkToRoom("agent-1", "lounge");

    const legs = getActivePlanLegs(system, "agent-1");
    expect(legs).not.toBeNull();
    expect(legs!.length).toBe(1);
    expect(legs![0].tag).toBeUndefined();
  });

  it("does NOT insert a dwell when not starting in the lounge", () => {
    // roomIdForCell returns null for col < 6.
    const entity = mockEntity("agent-1", 0, 0);
    registry._add("agent-1", entity);

    system.walkToRoom("agent-1", "desk");

    const legs = getActivePlanLegs(system, "agent-1");
    expect(legs).not.toBeNull();
    expect(legs!.length).toBe(1);
    expect(legs![0].tag).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MovementSystem.walkToRoom — unreachable-room-fallback rule
// ---------------------------------------------------------------------------

describe("MovementSystem — unreachable-room-fallback rule", () => {
  let bus: EventBus;
  let system: MovementSystem;
  let registry: ReturnType<typeof mockRegistry>;

  beforeEach(() => {
    bus = createEventBus();
    const ctx: SystemContext = { scene: mockScene(), bus };
    registry = mockRegistry();
    system = new MovementSystem(ctx, registry);
    system.init([] as SeatCell[], [], () => true);
  });

  it("redirects unreachable tool_workshop to the lounge fallback", () => {
    const entity = mockEntity("agent-1", 0, 0);
    registry._add("agent-1", entity);

    // Per the FALLBACK map in route-rules.ts, tool_workshop falls back
    // to meeting_room (not lounge — only rooms not in the FALLBACK map
    // fall through to lounge). Verify the rule picks meeting_room.
    system.walkToRoom("agent-1", "tool_workshop" as any);

    const legs = getActivePlanLegs(system, "agent-1");
    expect(legs).not.toBeNull();
    expect(legs!.length).toBe(1);
    expect(legs![0].room).toBe("meeting_room");
    // meeting_room anchor from the rooms mock is (4, 4).
    expect(legs![0].target).toEqual({ col: 4, row: 4 });
  });
});

// ---------------------------------------------------------------------------
// MovementSystem — multi-leg dwell progression
// ---------------------------------------------------------------------------

describe("MovementSystem — multi-leg dwell", () => {
  let bus: EventBus;
  let system: MovementSystem;
  let registry: ReturnType<typeof mockRegistry>;
  let scene: ReturnType<typeof mockScene>;

  beforeEach(() => {
    bus = createEventBus();
    scene = mockScene();
    const ctx: SystemContext = { scene, bus };
    registry = mockRegistry();
    system = new MovementSystem(ctx, registry);
    system.init([] as SeatCell[], [], () => true);
  });

  it("holds the agent for dwellMs before advancing to the next leg", () => {
    const entity = mockEntity("agent-1", 7, 7);
    registry._add("agent-1", entity);

    // Capture each tween's onComplete so we can drive the path forward.
    const tweenCallbacks: Array<() => void> = [];
    scene.tweens.add.mockImplementation((config: any) => {
      if (config.onComplete) tweenCallbacks.push(config.onComplete);
      return { destroy: vi.fn() };
    });

    // From lounge → desk inserts a coffee-stop (2 s dwell).
    system.walkToRoom("agent-1", "desk");
    expect(getActivePlanLegs(system, "agent-1")!.length).toBe(2);

    // First tick → first step (toward coffee-stop tile)
    system.tick();
    // Complete the tween → entity reaches the coffee-stop cell, leg drains.
    tweenCallbacks.shift()!();
    entity.visuals.tween = undefined;

    // Tick again → leg 0 has finished; dwell timer should be set.
    system.tick();
    const stateAfterDwell = (system as any).active.get("agent-1");
    expect(stateAfterDwell).toBeDefined();
    expect(stateAfterDwell.dwellUntil).toBe(2000);
    expect(stateAfterDwell.legIndex).toBe(0);

    // Tick before dwell expires → still on leg 0.
    scene.time.now = 1000;
    system.tick();
    expect((system as any).active.get("agent-1").legIndex).toBe(0);

    // Tick after dwell expires → advances to leg 1.
    scene.time.now = 2500;
    system.tick();
    expect((system as any).active.get("agent-1").legIndex).toBe(1);
  });
});
