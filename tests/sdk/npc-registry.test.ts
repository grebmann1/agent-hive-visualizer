import { describe, it, expect } from "vitest";
import { createEventBus } from "@/game/sdk/event-bus";
import { NpcRegistry } from "@/game/sdk/systems/NpcRegistry";

function createMockContext() {
  const bus = createEventBus();
  const scene = {
    add: {
      sprite: () => ({
        setDepth: () => ({ setTint: () => ({}) }),
        setTint: () => ({}),
        destroy: () => {},
      }),
      rectangle: () => ({
        setDepth: () => ({}),
        destroy: () => {},
      }),
    },
  } as any;
  return { scene, bus };
}

describe("NpcRegistry — pure helpers", () => {
  it("characterFor(id) is deterministic — same id always returns same character", () => {
    const ctx = createMockContext();
    const registry = new NpcRegistry(ctx);

    const char1 = registry.characterFor("agent-007");
    const char2 = registry.characterFor("agent-007");
    const char3 = registry.characterFor("agent-007");

    expect(char1).toBe(char2);
    expect(char2).toBe(char3);
  });

  it("characterFor(id) returns one of the known characters", () => {
    const ctx = createMockContext();
    const registry = new NpcRegistry(ctx);

    const validChars = ["Adam", "Alex", "Amelia", "Bob"];

    // Test several IDs to ensure they all map to valid characters
    const ids = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    for (const id of ids) {
      expect(validChars).toContain(registry.characterFor(id));
    }
  });

  it("tintFor(id) is deterministic — same id always returns same tint", () => {
    const ctx = createMockContext();
    const registry = new NpcRegistry(ctx);

    const tint1 = registry.tintFor("my-agent");
    const tint2 = registry.tintFor("my-agent");
    const tint3 = registry.tintFor("my-agent");

    expect(tint1).toBe(tint2);
    expect(tint2).toBe(tint3);
  });

  it("tintFor(id) returns a valid tint value from the palette", () => {
    const ctx = createMockContext();
    const registry = new NpcRegistry(ctx);

    const validTints = [
      0xffffff, 0xffd1a4, 0xa9d6ff, 0xffb1d2,
      0xc9e7a4, 0xd4b4ff, 0xffe17a, 0xa3e3d6,
    ];

    const ids = ["x", "y", "z", "foo", "bar", "baz"];
    for (const id of ids) {
      expect(validTints).toContain(registry.tintFor(id));
    }
  });

  it("sheetKeyFor(id) returns correct format: modern_<lowercase char>", () => {
    const ctx = createMockContext();
    const registry = new NpcRegistry(ctx);

    const key = registry.sheetKeyFor("test-agent");
    const char = registry.characterFor("test-agent");

    expect(key).toBe(`modern_${char.toLowerCase()}`);
  });

  it("idleKeyFor(id) returns correct format: modern_<lowercase char>_idle", () => {
    const ctx = createMockContext();
    const registry = new NpcRegistry(ctx);

    const key = registry.idleKeyFor("test-agent");
    const char = registry.characterFor("test-agent");

    expect(key).toBe(`modern_${char.toLowerCase()}_idle`);
  });

  it("sitKeyFor(id) returns correct format: modern_<lowercase char>_sit", () => {
    const ctx = createMockContext();
    const registry = new NpcRegistry(ctx);

    const key = registry.sitKeyFor("test-agent");
    const char = registry.characterFor("test-agent");

    expect(key).toBe(`modern_${char.toLowerCase()}_sit`);
  });

  it("different IDs can produce different characters (not all collide)", () => {
    const ctx = createMockContext();
    const registry = new NpcRegistry(ctx);

    // Generate characters for many IDs and check that we get more than one unique value
    const ids = Array.from({ length: 20 }, (_, i) => `agent-${i}`);
    const chars = new Set(ids.map((id) => registry.characterFor(id)));

    expect(chars.size).toBeGreaterThan(1);
  });

  it("different IDs can produce different tints (not all collide)", () => {
    const ctx = createMockContext();
    const registry = new NpcRegistry(ctx);

    const ids = Array.from({ length: 20 }, (_, i) => `agent-${i}`);
    const tints = new Set(ids.map((id) => registry.tintFor(id)));

    expect(tints.size).toBeGreaterThan(1);
  });
});
