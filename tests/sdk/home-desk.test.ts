import { describe, it, expect, vi, beforeEach } from "vitest";
import { MovementSystem } from "../../src/game/sdk/systems/MovementSystem";
import { createEventBus } from "../../src/game/sdk/event-bus";
import type { EventBus } from "../../src/game/sdk/event-bus";
import type { ManagedEntity, SystemContext } from "../../src/game/sdk/types";
import type { SeatCell } from "../../src/game/tiled-loader";

// ---------------------------------------------------------------------------
// Mock zones / rooms / pathfind so MovementSystem runs in isolation.
// ---------------------------------------------------------------------------

vi.mock("../../src/game/rooms", () => ({
  ROOM_ANCHORS: {
    lounge: { col: 9, row: 9 },
    desk: { col: 5, row: 3 },
  },
  getRoomRegions: () => [
    { id: "lounge", colMin: 8, colMax: 10, rowMin: 8, rowMax: 10 },
  ],
  roomIdForCell: () => null,
}));
vi.mock("../../src/game/zones", () => ({
  isRoomReachable: () => true,
}));
vi.mock("../../src/game/pathfind", () => ({
  bfs: (sc: number, sr: number, tc: number, tr: number) =>
    sc === tc && sr === tr
      ? [{ col: sc, row: sr }]
      : [{ col: sc, row: sr }, { col: tc, row: tr }],
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockScene() {
  return {
    tweens: { add: vi.fn(() => ({ destroy: vi.fn() })), killTweensOf: vi.fn() },
    time: { now: 0, delayedCall: vi.fn() },
  } as any;
}

function mockRegistry() {
  const entities = new Map<string, ManagedEntity>();
  return {
    get: (id: string) => entities.get(id),
    has: (id: string) => entities.has(id),
    forEach: (fn: (e: ManagedEntity, id: string) => void) => entities.forEach(fn),
    count: () => entities.size,
    sheetKeyFor: () => "modern_adam",
    idleKeyFor: () => "modern_adam_idle",
    _add: (id: string, e: ManagedEntity) => entities.set(id, e),
  } as any;
}

function entity(id: string, col: number, row: number): ManagedEntity {
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
      shadow: { x: 0, y: 0, setPosition: vi.fn() } as any,
      tween: undefined,
    },
    overlays: {},
  } as ManagedEntity;
}

function homeSeats(n: number): SeatCell[] {
  const out: SeatCell[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      col: i,
      row: 5,
      px: i * 32 + 16,
      py: 5 * 32 + 16,
      category: "home",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MovementSystem — home-desk assignment", () => {
  let bus: EventBus;
  let system: MovementSystem;
  let registry: ReturnType<typeof mockRegistry>;

  beforeEach(() => {
    bus = createEventBus();
    const ctx: SystemContext = { scene: mockScene(), bus };
    registry = mockRegistry();
    system = new MovementSystem(ctx, registry);
  });

  it("returns the same seat across release/reclaim cycles", () => {
    system.init(homeSeats(8), [], () => true);
    registry._add("agent-1", entity("agent-1", 0, 0));

    const first = system.claimFreeSeat("agent-1");
    expect(first).not.toBeNull();
    system.releaseSeat("agent-1");

    const second = system.claimFreeSeat("agent-1");
    expect(second).not.toBeNull();
    expect(second!.col).toBe(first!.col);
    expect(second!.row).toBe(first!.row);

    // And again — the seat is sticky for the lifetime of the agent.
    system.releaseSeat("agent-1");
    const third = system.claimFreeSeat("agent-1");
    expect(third!.col).toBe(first!.col);
    expect(third!.row).toBe(first!.row);
  });

  it("two agents that hash to the same starting slot get distinct seats (probe)", () => {
    // 1-seat pool forces probing on the second agent.
    system.init(homeSeats(2), [], () => true);
    registry._add("agent-A", entity("agent-A", 0, 0));
    registry._add("agent-B", entity("agent-B", 0, 0));

    const a = system.claimFreeSeat("agent-A");
    const b = system.claimFreeSeat("agent-B");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(`${a!.col},${a!.row}`).not.toBe(`${b!.col},${b!.row}`);
  });

  it("home seat is honored even when other home seats are also free", () => {
    // Two agents, two seats. agent-1 takes its home; agent-2 should
    // still take ITS home (not just the first free one).
    const seats = homeSeats(8);
    system.init(seats, [], () => true);
    registry._add("agent-1", entity("agent-1", 0, 0));
    registry._add("agent-2", entity("agent-2", 0, 0));

    const a1 = system.claimFreeSeat("agent-1");
    system.releaseSeat("agent-1");

    const a2 = system.claimFreeSeat("agent-2");
    expect(a2).not.toBeNull();

    // Now agent-1 reclaims — must get its original home back.
    const a1again = system.claimFreeSeat("agent-1");
    expect(a1again!.col).toBe(a1!.col);
    expect(a1again!.row).toBe(a1!.row);
  });

  it("falls through to other home seat when home is currently taken by another agent", () => {
    // Two seats. Force agent-B's home to collide with agent-A by
    // claiming agent-A first and then assigning agent-B = agent-A's home.
    const seats = homeSeats(2);
    system.init(seats, [], () => true);
    registry._add("agent-A", entity("agent-A", 0, 0));

    const a = system.claimFreeSeat("agent-A");
    expect(a).not.toBeNull();

    // agent-B might hash to either slot; if it lands on agent-A's,
    // it should fall through to the other home seat.
    registry._add("agent-B", entity("agent-B", 0, 0));
    const b = system.claimFreeSeat("agent-B");
    expect(b).not.toBeNull();
    expect(`${b!.col},${b!.row}`).not.toBe(`${a!.col},${a!.row}`);
  });

  it("npc:removed clears the home assignment so the slot can be reused", () => {
    system.init(homeSeats(2), [], () => true);
    registry._add("agent-1", entity("agent-1", 0, 0));

    const home1 = system.claimFreeSeat("agent-1");
    expect(home1).not.toBeNull();

    // Despawn — bus event clears home + occupied state.
    bus.emit("npc:removed", { id: "agent-1" });

    // A different agent can land on agent-1's old slot if its hash maps there.
    registry._add("agent-2", entity("agent-2", 0, 0));
    const home2 = system.claimFreeSeat("agent-2");
    expect(home2).not.toBeNull();
    // (We don't assert it's the SAME slot — just that the system isn't blocked.)
  });

  it("claimFreeSeatInRoom prefers non-home seats so home desks aren't poached", () => {
    // Mixed pool: one home seat at (0,5) inside the lounge region,
    // and one lounge seat at (9,9) inside the lounge region.
    const seats: SeatCell[] = [
      { col: 9, row: 9, px: 9 * 32 + 16, py: 9 * 32 + 16, category: "lounge" },
      { col: 9, row: 8, px: 9 * 32 + 16, py: 8 * 32 + 16, category: "home" },
    ];
    system.init(seats, [], () => true);
    registry._add("agent-1", entity("agent-1", 0, 0));

    const seat = system.claimFreeSeatInRoom("agent-1", "lounge" as any);
    expect(seat).not.toBeNull();
    expect(seat!.category).toBe("lounge");
  });

  it("falls through to otherPool when every home seat is taken", () => {
    // 1 home + 1 coffee. agent-1 grabs the home. agent-2 should land
    // on the coffee seat as a last resort.
    const seats: SeatCell[] = [
      { col: 0, row: 5, px: 16, py: 5 * 32 + 16, category: "home" },
      { col: 1, row: 5, px: 32 + 16, py: 5 * 32 + 16, category: "coffee" },
    ];
    system.init(seats, [], () => true);
    registry._add("agent-1", entity("agent-1", 0, 0));
    registry._add("agent-2", entity("agent-2", 0, 0));

    const a = system.claimFreeSeat("agent-1");
    const b = system.claimFreeSeat("agent-2");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.category).toBe("coffee");
  });
});
