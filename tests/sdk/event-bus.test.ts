import { describe, it, expect, vi } from "vitest";
import { createEventBus } from "@/game/sdk/event-bus";

describe("EventBus", () => {
  it("emit delivers to subscribers synchronously", () => {
    const bus = createEventBus();
    const results: string[] = [];

    bus.on("npc:spawned", () => {
      results.push("first");
    });
    bus.on("npc:spawned", () => {
      results.push("second");
    });

    bus.emit("npc:spawned", { id: "a1", col: 0, row: 0, isSubAgent: false });

    // Results are populated synchronously — no awaiting needed
    expect(results).toEqual(["first", "second"]);
  });

  it("on returns an unsubscribe function that works", () => {
    const bus = createEventBus();
    const handler = vi.fn();

    const unsub = bus.on("npc:removed", handler);

    bus.emit("npc:removed", { id: "x" });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();

    bus.emit("npc:removed", { id: "y" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("once fires only once then auto-removes", () => {
    const bus = createEventBus();
    const handler = vi.fn();

    bus.once("move:arrived", handler);

    bus.emit("move:arrived", { id: "a", col: 1, row: 2 });
    bus.emit("move:arrived", { id: "b", col: 3, row: 4 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ id: "a", col: 1, row: 2 });
  });

  it("multiple listeners on same event all fire", () => {
    const bus = createEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();

    bus.on("interact:click", h1);
    bus.on("interact:click", h2);
    bus.on("interact:click", h3);

    bus.emit("interact:click", { id: "npc1" });

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h3).toHaveBeenCalledTimes(1);
  });

  it("emitting an event with no listeners does not throw", () => {
    const bus = createEventBus();

    expect(() => {
      bus.emit("npc:spawned", { id: "z", col: 0, row: 0, isSubAgent: false });
    }).not.toThrow();
  });

  it("destroy clears all listeners", () => {
    const bus = createEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on("npc:spawned", h1);
    bus.on("move:arrived", h2);

    bus.destroy();

    bus.emit("npc:spawned", { id: "a", col: 0, row: 0, isSubAgent: false });
    bus.emit("move:arrived", { id: "b", col: 1, row: 1 });

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it("listener receives the exact payload object (no copy)", () => {
    const bus = createEventBus();
    let received: unknown = null;

    bus.on("npc:spawned", (payload) => {
      received = payload;
    });

    const payload = { id: "ref-test", col: 5, row: 10, isSubAgent: true };
    bus.emit("npc:spawned", payload);

    // Same reference, not a copy
    expect(received).toBe(payload);
  });
});
