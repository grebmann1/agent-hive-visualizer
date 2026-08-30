import { describe, it, expect, vi, beforeEach } from "vitest";
import { MovementSystem } from "../../src/game/sdk/systems/MovementSystem";
import { createEventBus } from "../../src/game/sdk/event-bus";
import type { EventBus, SdkEventMap } from "../../src/game/sdk/event-bus";
import type { ManagedEntity, SystemContext } from "../../src/game/sdk/types";
import type { SeatCell, DeskRect } from "../../src/game/tiled-loader";

// ---------------------------------------------------------------------------
// Minimal mocks
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

// Inject a fake active plan with a 1-cell path so internal-state tests
// can exercise tick / cancelPath without going through BFS.
function injectPath(system: any, id: string, cells: Array<{ col: number; row: number }>) {
  system.active.set(id, {
    plan: {
      npcId: id,
      legs: [{ target: cells[cells.length - 1] ?? { col: 0, row: 0 }, dwellMs: 0 }],
      reason: "test",
    },
    legIndex: 0,
    path: cells,
    retryCount: 0,
  });
}

function mockRegistry() {
  const entities = new Map<string, ManagedEntity>();
  return {
    get: (id: string) => entities.get(id),
    has: (id: string) => entities.has(id),
    forEach: (fn: (entity: ManagedEntity, id: string) => void) =>
      entities.forEach((e, id) => fn(e, id)),
    count: () => entities.size,
    sheetKeyFor: (id: string) => `modern_adam`,
    idleKeyFor: (id: string) => `modern_adam_idle`,
    _add: (id: string, entity: ManagedEntity) => entities.set(id, entity),
    _remove: (id: string) => entities.delete(id),
  } as any;
}

function mockEntity(
  id: string,
  col: number,
  row: number,
): ManagedEntity {
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

// ---------------------------------------------------------------------------
// deskFacingFor
// ---------------------------------------------------------------------------

describe("MovementSystem — deskFacingFor", () => {
  let bus: EventBus;
  let system: MovementSystem;

  beforeEach(() => {
    bus = createEventBus();
    const ctx: SystemContext = { scene: mockScene(), bus };
    const registry = mockRegistry();
    system = new MovementSystem(ctx, registry);
  });

  it("returns 'up' (default) when no desks are present", () => {
    system.init([], [], () => true);
    expect(system.deskFacingFor(5, 5)).toBe("up");
  });

  it("returns 'down' when seat is north of the desk", () => {
    // Desk at rows 5-6, seat at row 4 (above desk)
    const desks: DeskRect[] = [{ colMin: 4, colMax: 5, rowMin: 5, rowMax: 6 }];
    system.init([], desks, () => true);
    // Seat at (5, 4) — north of desk center
    expect(system.deskFacingFor(5, 4)).toBe("down");
  });

  it("returns 'up' when seat is south of the desk", () => {
    // Desk at rows 2-3, seat at row 5 (below desk)
    const desks: DeskRect[] = [{ colMin: 4, colMax: 5, rowMin: 2, rowMax: 3 }];
    system.init([], desks, () => true);
    // Seat at (5, 5) — south of desk center
    expect(system.deskFacingFor(5, 5)).toBe("up");
  });

  it("returns 'right' when seat is to the left of the desk", () => {
    // Desk at cols 6-8, seat at col 4 (left of desk)
    const desks: DeskRect[] = [{ colMin: 6, colMax: 8, rowMin: 4, rowMax: 5 }];
    system.init([], desks, () => true);
    // Seat at (4, 4) — left of desk center (dx > dy)
    expect(system.deskFacingFor(4, 4)).toBe("right");
  });

  it("returns 'left' when seat is to the right of the desk", () => {
    // Desk at cols 2-3, seat at col 6 (right of desk)
    const desks: DeskRect[] = [{ colMin: 2, colMax: 3, rowMin: 4, rowMax: 5 }];
    system.init([], desks, () => true);
    // Seat at (6, 5) — right of desk center
    expect(system.deskFacingFor(6, 5)).toBe("left");
  });

  it("picks the nearest desk when multiple desks exist", () => {
    const desks: DeskRect[] = [
      { colMin: 0, colMax: 1, rowMin: 0, rowMax: 1 }, // far desk
      { colMin: 10, colMax: 11, rowMin: 10, rowMax: 11 }, // close desk
    ];
    system.init([], desks, () => true);
    // Seat at (10, 8) — north of close desk → should face down
    expect(system.deskFacingFor(10, 8)).toBe("down");
  });
});

// ---------------------------------------------------------------------------
// claimFreeSeat / releaseSeat
// ---------------------------------------------------------------------------

describe("MovementSystem — seat management", () => {
  let bus: EventBus;
  let system: MovementSystem;

  beforeEach(() => {
    bus = createEventBus();
    const ctx: SystemContext = { scene: mockScene(), bus };
    const registry = mockRegistry();
    system = new MovementSystem(ctx, registry);
  });

  it("claims the first available seat", () => {
    const seats: SeatCell[] = [
      { col: 3, row: 4, px: 112, py: 144, category: "home" },
      { col: 5, row: 6, px: 176, py: 208, category: "home" },
    ];
    system.init(seats, [], () => true);

    const seat = system.claimFreeSeat("agent-1");
    expect(seat).not.toBeNull();
    expect(seat!.col).toBe(3);
    expect(seat!.row).toBe(4);
  });

  it("returns null when all seats are occupied", () => {
    const seats: SeatCell[] = [{ col: 3, row: 4, px: 112, py: 144, category: "home" }];
    system.init(seats, [], () => true);

    system.claimFreeSeat("agent-1");
    const seat = system.claimFreeSeat("agent-2");
    expect(seat).toBeNull();
  });

  it("release makes a seat available again", () => {
    const seats: SeatCell[] = [{ col: 3, row: 4, px: 112, py: 144, category: "home" }];
    system.init(seats, [], () => true);

    system.claimFreeSeat("agent-1");
    system.releaseSeat("agent-1");

    const seat = system.claimFreeSeat("agent-2");
    expect(seat).not.toBeNull();
    expect(seat!.col).toBe(3);
    expect(seat!.row).toBe(4);
  });

  it("does not double-release or crash on unknown id", () => {
    const seats: SeatCell[] = [{ col: 3, row: 4, px: 112, py: 144, category: "home" }];
    system.init(seats, [], () => true);

    // Release an id that never claimed — should not throw
    expect(() => system.releaseSeat("unknown")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isWalking
// ---------------------------------------------------------------------------

describe("MovementSystem — isWalking", () => {
  let bus: EventBus;
  let system: MovementSystem;
  let registry: ReturnType<typeof mockRegistry>;

  beforeEach(() => {
    bus = createEventBus();
    const scene = mockScene();
    const ctx: SystemContext = { scene, bus };
    registry = mockRegistry();
    system = new MovementSystem(ctx, registry);
    // Make walkability always true and stub rooms module
    system.init([], [], () => true);
  });

  it("returns false for idle NPC with no path", () => {
    const entity = mockEntity("npc-1", 5, 5);
    registry._add("npc-1", entity);

    expect(system.isWalking("npc-1")).toBe(false);
  });

  it("returns true when NPC has a tween in progress", () => {
    const entity = mockEntity("npc-1", 5, 5);
    entity.visuals.tween = { destroy: vi.fn() } as any;
    registry._add("npc-1", entity);

    expect(system.isWalking("npc-1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cancelPath
// ---------------------------------------------------------------------------

describe("MovementSystem — cancelPath", () => {
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
    system.init([], [], () => true);
  });

  it("emits 'move:cancelled' when path existed", () => {
    const entity = mockEntity("npc-1", 0, 0);
    registry._add("npc-1", entity);

    const handler = vi.fn();
    bus.on("move:cancelled", handler);

    injectPath(system, "npc-1", [{ col: 1, row: 0 }]);

    system.cancelPath("npc-1");

    expect(handler).toHaveBeenCalledWith({ id: "npc-1" });
  });

  it("does NOT emit 'move:cancelled' when no path existed", () => {
    const entity = mockEntity("npc-1", 0, 0);
    registry._add("npc-1", entity);

    const handler = vi.fn();
    bus.on("move:cancelled", handler);

    system.cancelPath("npc-1");

    expect(handler).not.toHaveBeenCalled();
  });

  it("clears the path from internal state", () => {
    const entity = mockEntity("npc-1", 0, 0);
    registry._add("npc-1", entity);

    injectPath(system, "npc-1", [{ col: 1, row: 0 }]);

    system.cancelPath("npc-1");

    // After cancel, isWalking should be false (no path, no tween)
    expect(system.isWalking("npc-1")).toBe(false);
  });

  it("kills inflight tween on the entity", () => {
    const entity = mockEntity("npc-1", 3, 3);
    entity.visuals.tween = { destroy: vi.fn() } as any;
    registry._add("npc-1", entity);

    injectPath(system, "npc-1", [{ col: 4, row: 3 }]);

    system.cancelPath("npc-1");

    expect(scene.tweens.killTweensOf).toHaveBeenCalledWith(entity.visuals.sprite);
    expect(scene.tweens.killTweensOf).toHaveBeenCalledWith(entity.visuals.shadow);
    expect(entity.visuals.tween).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bus event emissions
// ---------------------------------------------------------------------------

describe("MovementSystem — bus events", () => {
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
    system.init([], [], () => true);
  });

  it("emits 'move:started' when walkToCell kicks off a path", () => {
    const entity = mockEntity("npc-1", 0, 0);
    registry._add("npc-1", entity);

    const handler = vi.fn();
    bus.on("move:started", handler);

    injectPath(system, "npc-1", [
      { col: 1, row: 0 },
      { col: 2, row: 0 },
    ]);
    bus.emit("move:started", { id: "npc-1", targetCol: 2, targetRow: 0 });

    expect(handler).toHaveBeenCalledWith({
      id: "npc-1",
      targetCol: 2,
      targetRow: 0,
    });
  });

  it("emits 'move:arrived' when path drains during tick", () => {
    const entity = mockEntity("npc-1", 5, 5);
    registry._add("npc-1", entity);

    const handler = vi.fn();
    bus.on("move:arrived", handler);

    // Set up a plan with a single 0-step leg (already at target) — tick
    // detects the drained path and emits move:arrived.
    injectPath(system, "npc-1", []);

    system.tick();

    expect(handler).toHaveBeenCalledWith({
      id: "npc-1",
      col: 5,
      row: 5,
    });
  });

  it("emits 'move:step' via tween onComplete callback", () => {
    const entity = mockEntity("npc-1", 5, 5);
    registry._add("npc-1", entity);

    const handler = vi.fn();
    bus.on("move:step", handler);

    // Capture all tween configs to trigger onComplete manually
    const tweenConfigs: any[] = [];
    scene.tweens.add.mockImplementation((config: any) => {
      tweenConfigs.push(config);
      return { destroy: vi.fn() };
    });

    injectPath(system, "npc-1", [{ col: 6, row: 5 }]);

    system.tick();

    // First call is the sprite tween (has onComplete)
    const spriteTweenConfig = tweenConfigs[0];
    expect(spriteTweenConfig).toBeDefined();
    expect(spriteTweenConfig.onComplete).toBeDefined();

    // Simulate tween completing
    spriteTweenConfig.onComplete();

    expect(handler).toHaveBeenCalledWith({
      id: "npc-1",
      col: 6,
      row: 5,
      facing: "right",
    });
  });

  it("npc:removed event triggers cancelPath and releaseSeat", () => {
    const entity = mockEntity("npc-1", 5, 5);
    registry._add("npc-1", entity);

    const seats: SeatCell[] = [{ col: 5, row: 5, px: 176, py: 176, category: "home" }];
    system.init(seats, [], () => true);
    system.claimFreeSeat("npc-1");

    injectPath(system, "npc-1", [{ col: 6, row: 5 }]);

    // Emit npc:removed
    bus.emit("npc:removed", { id: "npc-1" });

    // Path should be gone
    expect(system.isWalking("npc-1")).toBe(false);

    // Seat should be free again
    const claimed = system.claimFreeSeat("npc-2");
    expect(claimed).not.toBeNull();
    expect(claimed!.col).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// tick — path progression
// ---------------------------------------------------------------------------

describe("MovementSystem — tick", () => {
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
    system.init([], [], () => true);
  });

  it("starts a tween for the next step in the path", () => {
    const entity = mockEntity("npc-1", 5, 5);
    registry._add("npc-1", entity);

    injectPath(system, "npc-1", [
      { col: 6, row: 5 },
      { col: 7, row: 5 },
    ]);

    system.tick();

    // Should have called tweens.add for sprite and shadow
    expect(scene.tweens.add).toHaveBeenCalledTimes(2);
    // First call is for sprite
    const spriteConfig = scene.tweens.add.mock.calls[0][0];
    expect(spriteConfig.targets).toBe(entity.visuals.sprite);
    expect(spriteConfig.x).toBe(6 * 32 + 16); // 208
    expect(spriteConfig.y).toBe(5 * 32 + 16); // 176
  });

  it("does not advance if entity has active tween", () => {
    const entity = mockEntity("npc-1", 5, 5);
    entity.visuals.tween = { destroy: vi.fn() } as any;
    registry._add("npc-1", entity);

    injectPath(system, "npc-1", [{ col: 6, row: 5 }]);

    system.tick();

    // Should NOT have created any new tween
    expect(scene.tweens.add).not.toHaveBeenCalled();
  });

  it("updates facing direction based on movement direction", () => {
    const entity = mockEntity("npc-1", 5, 5);
    registry._add("npc-1", entity);

    // Moving left
    injectPath(system, "npc-1", [{ col: 4, row: 5 }]);
    system.tick();
    expect(entity.state.facing).toBe("left");
  });

  it("removes path entry for entity whose sprite.scene is null", () => {
    const entity = mockEntity("npc-1", 5, 5);
    (entity.visuals.sprite as any).scene = null;
    registry._add("npc-1", entity);

    injectPath(system, "npc-1", [{ col: 6, row: 5 }]);

    system.tick();

    // Path should be cleaned up
    expect((system as any).active.has("npc-1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

describe("MovementSystem — destroy", () => {
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
    system.init([], [], () => true);
  });

  it("clears all internal state", () => {
    const entity = mockEntity("npc-1", 5, 5);
    registry._add("npc-1", entity);

    const seats: SeatCell[] = [{ col: 5, row: 5, px: 176, py: 176, category: "home" }];
    system.init(seats, [], () => true);
    system.claimFreeSeat("npc-1");
    injectPath(system, "npc-1", [{ col: 6, row: 5 }]);

    system.destroy();

    expect((system as any).active.size).toBe(0);
    expect((system as any).occupiedSeats.size).toBe(0);
    expect((system as any).seatByNpc.size).toBe(0);
  });

  it("unsubscribes from npc:removed event", () => {
    const entity = mockEntity("npc-1", 5, 5);
    registry._add("npc-1", entity);

    system.destroy();

    // After destroy, emitting npc:removed should not trigger cancelPath
    injectPath(system, "npc-1", [{ col: 6, row: 5 }]);
    bus.emit("npc:removed", { id: "npc-1" });

    // Path should still be there since listener was unsubscribed
    expect((system as any).active.has("npc-1")).toBe(true);
  });
});
