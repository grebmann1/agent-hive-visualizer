import { describe, it, expect, vi, beforeEach } from "vitest";
import { MovementSystem } from "../../src/game/sdk/systems/MovementSystem";
import { createEventBus } from "../../src/game/sdk/event-bus";
import type { EventBus } from "../../src/game/sdk/event-bus";
import type { ManagedEntity, SystemContext } from "../../src/game/sdk/types";
import type { SeatCell, DeskRect } from "../../src/game/tiled-loader";

// ---------------------------------------------------------------------------
// We mock the modules that MovementSystem imports so BFS uses our grid.
// ---------------------------------------------------------------------------

vi.mock("../../src/game/rooms", () => {
  // A simple 10x10 grid where everything is walkable
  const MAP_COLS = 10;
  const MAP_ROWS = 10;
  const walkableGrid = Array.from({ length: MAP_ROWS }, () =>
    Array.from({ length: MAP_COLS }, () => true),
  );
  return {
    MAP_COLS,
    MAP_ROWS,
    TILE_PX: 32,
    isWalkable: (col: number, row: number) => {
      if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return false;
      return walkableGrid[row][col];
    },
    ROOM_ANCHORS: {
      lounge: { id: "lounge", label: "Coffee Bar", col: 7, row: 7, labelCol: 5, labelRow: 5 },
      library: { id: "library", label: "Training", col: 2, row: 2, labelCol: 0, labelRow: 0 },
    },
    getRoomRegions: () => [
      { id: "lounge", colMin: 6, colMax: 9, rowMin: 6, rowMax: 9 },
      { id: "library", colMin: 0, colMax: 4, rowMin: 0, rowMax: 4 },
    ],
    setActiveZone: vi.fn(),
    roomIdForCell: vi.fn(),
    ROOM_REGIONS: [],
  };
});

vi.mock("../../src/game/pathfind", async () => {
  // Re-implement BFS for 10x10 grid using the mocked rooms module
  const MAP_COLS = 10;
  const MAP_ROWS = 10;

  function key(col: number, row: number): number {
    return row * MAP_COLS + col;
  }

  function isWalkable(col: number, row: number): boolean {
    if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return false;
    return true;
  }

  function bfs(
    sc: number,
    sr: number,
    tc: number,
    tr: number,
    opts: { blocked?: Iterable<{ col: number; row: number }> } = {},
  ) {
    const blockedSet = new Set<number>();
    if (opts.blocked) {
      for (const b of opts.blocked) blockedSet.add(key(b.col, b.row));
    }
    if (!isWalkable(tc, tr) || blockedSet.has(key(tc, tr))) return [];
    if (sc === tc && sr === tr) return [{ col: sc, row: sr }];

    const prev = new Map<number, number>();
    const queue: Array<{ col: number; row: number }> = [{ col: sc, row: sr }];
    const seen = new Set<number>([key(sc, sr)]);

    const dirs: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];

    let found = false;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.col === tc && cur.row === tr) {
        found = true;
        break;
      }
      for (const [dc, dr] of dirs) {
        const nc = cur.col + dc;
        const nr = cur.row + dr;
        if (nc < 0 || nc >= MAP_COLS || nr < 0 || nr >= MAP_ROWS) continue;
        const k = key(nc, nr);
        if (seen.has(k)) continue;
        if (!isWalkable(nc, nr)) continue;
        if (blockedSet.has(k)) continue;
        seen.add(k);
        prev.set(k, key(cur.col, cur.row));
        queue.push({ col: nc, row: nr });
      }
    }

    if (!found) return [];

    const path: Array<{ col: number; row: number }> = [];
    let ck = key(tc, tr);
    const startK = key(sc, sr);
    while (ck !== startK) {
      const col = ck % MAP_COLS;
      const row = Math.floor(ck / MAP_COLS);
      path.push({ col, row });
      const p = prev.get(ck);
      if (p === undefined) return [];
      ck = p;
    }
    path.push({ col: sc, row: sr });
    return path.reverse();
  }

  return { bfs };
});

// ---------------------------------------------------------------------------
// Mock helpers (following existing test patterns)
// ---------------------------------------------------------------------------

const TILE_SIZE = 32;

function mockScene() {
  const tweenCallbacks: Function[] = [];
  return {
    tweens: {
      add: vi.fn((config: any) => {
        if (config.onComplete) tweenCallbacks.push(config.onComplete);
        return { destroy: vi.fn() };
      }),
      killTweensOf: vi.fn(),
    },
    time: { now: 0 },
    _completeTweens: () => {
      tweenCallbacks.forEach((cb) => cb());
      tweenCallbacks.length = 0;
    },
    _tweenCount: () => tweenCallbacks.length,
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
    sheetKeyFor: (_id: string) => `modern_adam`,
    idleKeyFor: (_id: string) => `modern_adam_idle`,
    _add: (id: string, entity: ManagedEntity) => entities.set(id, entity),
    _remove: (id: string) => entities.delete(id),
  } as any;
}

function createEntity(id: string, col: number, row: number): ManagedEntity {
  const entity: ManagedEntity = {
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
        x: col * TILE_SIZE + TILE_SIZE / 2,
        y: row * TILE_SIZE + TILE_SIZE / 2,
        scene: {},
        play: vi.fn(),
        stop: vi.fn(),
        setTexture: vi.fn(),
        setPosition: vi.fn(function (this: any, x: number, y: number) {
          entity.visuals.sprite.x = x;
          entity.visuals.sprite.y = y;
        }),
        setDepth: vi.fn(),
        texture: { key: "modern_adam" },
      } as any,
      shadow: {
        x: col * TILE_SIZE + TILE_SIZE / 2,
        y: row * TILE_SIZE + TILE_SIZE / 2 + 7,
        setPosition: vi.fn(function (this: any, x: number, y: number) {
          entity.visuals.shadow.x = x;
          entity.visuals.shadow.y = y;
        }),
      } as any,
      tween: undefined,
    },
    overlays: {},
  } as ManagedEntity;
  return entity;
}

// ===========================================================================
// Scenario 1: Agent arrives -> walks to desk -> sits facing monitors
// ===========================================================================

describe("Scenario 1: Agent arrives, walks to desk, sits facing monitors", () => {
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

    // Seat at (5,3), desk rect covering (5,4)-(6,5)
    const seats: SeatCell[] = [{ col: 5, row: 3, px: 5 * 32 + 16, py: 3 * 32 + 16 }];
    const desks: DeskRect[] = [{ colMin: 5, colMax: 6, rowMin: 4, rowMax: 5 }];
    system.init(seats, desks, () => true);
  });

  it("claimFreeSeat returns the seat at (5,3)", () => {
    const entity = createEntity("agent-1", 0, 0);
    registry._add("agent-1", entity);

    const seat = system.claimFreeSeat("agent-1");
    expect(seat).not.toBeNull();
    expect(seat!.col).toBe(5);
    expect(seat!.row).toBe(3);
  });

  it("walkToCell emits move:started", () => {
    const entity = createEntity("agent-1", 0, 0);
    registry._add("agent-1", entity);

    const startedHandler = vi.fn();
    bus.on("move:started", startedHandler);

    const seat = system.claimFreeSeat("agent-1");
    system.walkToCell("agent-1", seat!.col, seat!.row, { px: seat!.px, py: seat!.py });

    expect(startedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-1",
        targetCol: 5,
        targetRow: 3,
      }),
    );
  });

  it("tween completions lead to move:arrived", () => {
    const entity = createEntity("agent-1", 0, 0);
    registry._add("agent-1", entity);

    const arrivedHandler = vi.fn();
    bus.on("move:arrived", arrivedHandler);

    const seat = system.claimFreeSeat("agent-1");
    system.walkToCell("agent-1", seat!.col, seat!.row, { px: seat!.px, py: seat!.py });

    // Advance through the path by ticking + completing tweens
    // The path from (0,0) to (5,3) is 8 steps. On each tick, a tween
    // is started; when we complete it the entity advances one cell.
    for (let i = 0; i < 20; i++) {
      system.tick();
      // Mark tween as undefined to simulate completion and update state
      // The onComplete callback was captured by scene.tweens.add
      scene._completeTweens();
      entity.visuals.tween = undefined;
    }

    expect(arrivedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-1",
        col: 5,
        row: 3,
      }),
    );
  });

  it("deskFacingFor(5, 3) returns 'down' because desk is south", () => {
    // Seat at row 3, desk at rows 4-5 => desk center is south of seat
    expect(system.deskFacingFor(5, 3)).toBe("down");
  });
});

// ===========================================================================
// Scenario 3: Agent idle for 60s -> walks to lounge
// ===========================================================================

describe("Scenario 3: Agent idle, releases seat, walks to lounge", () => {
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

    const seats: SeatCell[] = [
      { col: 5, row: 3, px: 5 * 32 + 16, py: 3 * 32 + 16 },
      { col: 6, row: 3, px: 6 * 32 + 16, py: 3 * 32 + 16 },
    ];
    system.init(seats, [], () => true);
  });

  it("releaseSeat frees the seat for another agent", () => {
    const entity = createEntity("agent-1", 5, 3);
    registry._add("agent-1", entity);

    system.claimFreeSeat("agent-1");

    // Release the seat
    system.releaseSeat("agent-1");

    // Another agent can now claim it
    const entity2 = createEntity("agent-2", 0, 0);
    registry._add("agent-2", entity2);
    const seat = system.claimFreeSeat("agent-2");
    expect(seat).not.toBeNull();
    expect(seat!.col).toBe(5);
    expect(seat!.row).toBe(3);
  });

  it("walkToRoom emits move:started with room='lounge'", () => {
    const entity = createEntity("agent-1", 5, 3);
    registry._add("agent-1", entity);

    system.claimFreeSeat("agent-1");
    system.releaseSeat("agent-1");

    const startedHandler = vi.fn();
    bus.on("move:started", startedHandler);

    system.walkToRoom("agent-1", "lounge");

    expect(startedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-1",
        room: "lounge",
      }),
    );
  });

  it("seat remains available after agent walks to lounge", () => {
    const entity = createEntity("agent-1", 5, 3);
    registry._add("agent-1", entity);

    system.claimFreeSeat("agent-1");
    system.releaseSeat("agent-1");
    system.walkToRoom("agent-1", "lounge");

    // Seat should be claimable by another agent
    const entity2 = createEntity("agent-2", 0, 0);
    registry._add("agent-2", entity2);
    const seat = system.claimFreeSeat("agent-2");
    expect(seat).not.toBeNull();
    expect(seat!.col).toBe(5);
  });
});

// ===========================================================================
// Scenario 9: Agent walks mid-path -> new event redirects -> no teleport
// ===========================================================================

describe("Scenario 9: Mid-path redirect without teleport", () => {
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

  it("kills tweens, snaps to nearest tile, emits new move:started from snapped position", () => {
    // Agent starts at (0, 0) heading to (5, 0) — a 5-cell path
    const entity = createEntity("agent-1", 0, 0);
    registry._add("agent-1", entity);

    system.walkToCell("agent-1", 5, 0);

    // Simulate 2 steps: tick + complete tween for each step
    // Step 1: tick starts tween to (1,0)
    system.tick();
    scene._completeTweens();
    entity.visuals.tween = undefined;
    // After onComplete, entity.state should be at (1,0)

    // Step 2: tick starts tween to (2,0)
    system.tick();
    // Now the entity has an active tween (mid-step to (2,0))
    // Simulate the sprite being mid-tween at pixel position between col 1 and col 2
    entity.visuals.sprite.x = 1.5 * TILE_SIZE + TILE_SIZE / 2; // midway
    entity.visuals.sprite.y = 0 * TILE_SIZE + TILE_SIZE / 2;
    entity.visuals.tween = { destroy: vi.fn() } as any;

    // Now redirect to library while mid-tween
    const startedHandler = vi.fn();
    bus.on("move:started", startedHandler);

    system.walkToRoom("agent-1", "library");

    // Verify tweens were killed
    expect(scene.tweens.killTweensOf).toHaveBeenCalledWith(entity.visuals.sprite);
    expect(scene.tweens.killTweensOf).toHaveBeenCalledWith(entity.visuals.shadow);

    // Entity should have snapped to nearest tile (col 2 based on pixel position)
    // Snapping logic: Math.round((sprite.x - TILE_SIZE/2) / TILE_SIZE)
    // sprite.x = 1.5*32 + 16 = 48 + 16 = 64. (64 - 16) / 32 = 1.5 => rounds to 2
    expect(entity.state.col).toBe(2);
    expect(entity.state.row).toBe(0);

    // New move:started should have been emitted for the library path
    expect(startedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-1",
        room: "library",
      }),
    );

    // The sprite should have been snapped to tile position (not teleported to origin)
    const snappedX = 2 * TILE_SIZE + TILE_SIZE / 2;
    const snappedY = 0 * TILE_SIZE + TILE_SIZE / 2;
    expect(entity.visuals.sprite.setPosition).toHaveBeenCalledWith(snappedX, snappedY);
  });
});

// ===========================================================================
// Scenario 12: Seat exhaustion -> fallback to spawn cell
// ===========================================================================

describe("Scenario 12: Seat exhaustion, fallback to spawn cell", () => {
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

    // Only 2 seats available
    const seats: SeatCell[] = [
      { col: 3, row: 3, px: 3 * 32 + 16, py: 3 * 32 + 16 },
      { col: 4, row: 3, px: 4 * 32 + 16, py: 3 * 32 + 16 },
    ];
    system.init(seats, [], () => true);
  });

  it("claimFreeSeat returns null when all seats are taken", () => {
    const entityA = createEntity("agent-A", 0, 0);
    const entityB = createEntity("agent-B", 1, 0);
    const entityC = createEntity("agent-C", 2, 0);
    registry._add("agent-A", entityA);
    registry._add("agent-B", entityB);
    registry._add("agent-C", entityC);

    // Claim both seats
    const seatA = system.claimFreeSeat("agent-A");
    expect(seatA).not.toBeNull();

    const seatB = system.claimFreeSeat("agent-B");
    expect(seatB).not.toBeNull();

    // Third agent gets null
    const seatC = system.claimFreeSeat("agent-C");
    expect(seatC).toBeNull();
  });

  it("agent-C falls back to spawn cell with move:started emitted (no crash)", () => {
    const entityA = createEntity("agent-A", 0, 0);
    const entityB = createEntity("agent-B", 1, 0);
    const entityC = createEntity("agent-C", 2, 0);
    registry._add("agent-A", entityA);
    registry._add("agent-B", entityB);
    registry._add("agent-C", entityC);

    system.claimFreeSeat("agent-A");
    system.claimFreeSeat("agent-B");

    // Seat exhaustion — agent-C cannot get a seat
    const seatC = system.claimFreeSeat("agent-C");
    expect(seatC).toBeNull();

    // Fallback: walk agent-C to a spawn cell
    const spawnCol = 8;
    const spawnRow = 8;
    const startedHandler = vi.fn();
    bus.on("move:started", startedHandler);

    // This should not crash
    expect(() => {
      system.walkToCell("agent-C", spawnCol, spawnRow);
    }).not.toThrow();

    // move:started should be emitted for the fallback walk
    expect(startedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-C",
        targetCol: spawnCol,
        targetRow: spawnRow,
      }),
    );
  });
});
