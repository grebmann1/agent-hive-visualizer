import { describe, it, expect } from "vitest";
import {
  ChitChatEngine,
  chatProbForRoom,
} from "@/game/world-life/chit-chat-engine";
import { nextState } from "@/game/world-life/state-machine";
import { WORLD_LIFE_TUNABLES } from "@/game/world-life/tunables";
import { createEventBus } from "@/game/sdk/event-bus";
import { NpcRegistry } from "@/game/sdk/systems/NpcRegistry";

// ---------------------------------------------------------------------------
// Scenario 5: Two idle agents in same room -> chit-chat starts -> interrupted
// ---------------------------------------------------------------------------

describe("Scenario 5 — ChitChatEngine: idle agents chat then tool interrupts", () => {
  it("tryStartChat creates a valid session with greeting as first exchange", () => {
    const engine = new ChitChatEngine();
    const now = Date.now();

    const session = engine.tryStartChat("agent-a", "agent-b", "neutral", now);

    expect(session).not.toBeNull();
    expect(session!.initiatorId).toBe("agent-a");
    expect(session!.partnerId).toBe("agent-b");
    expect(session!.ended).toBe(false);
    // First exchange is always the greeting (id=1)
    expect(session!.exchanges[0]).toBe(1);
  });

  it("advance returns next exchange with a speaker and emoji", () => {
    const engine = new ChitChatEngine();
    const now = Date.now();

    const session = engine.tryStartChat("agent-a", "agent-b", "neutral", now)!;
    const result = engine.advance(session.sessionId, now + 1000);

    expect(result).not.toBeNull();
    expect(result!.speaker).toBeDefined();
    expect(result!.emoji).toBeDefined();
    expect(result!.emoji.length).toBeGreaterThan(0);
  });

  it("interrupt ends session and marks interruptedBy", () => {
    const engine = new ChitChatEngine();
    const now = Date.now();

    const session = engine.tryStartChat("agent-a", "agent-b", "neutral", now)!;
    engine.advance(session.sessionId, now + 1000);

    engine.interrupt(session.sessionId, "agent-a", now + 2000);

    expect(session.ended).toBe(true);
    expect(session.interruptedBy).toBe("agent-a");
  });

  it("both agents are on cooldown after interruption", () => {
    const engine = new ChitChatEngine();
    const now = Date.now();

    const session = engine.tryStartChat("agent-a", "agent-b", "neutral", now)!;
    engine.interrupt(session.sessionId, "agent-a", now + 2000);

    // Both agents should be on cooldown right after interrupt
    expect(engine.canChat("agent-a", now + 2000)).toBe(false);
    expect(engine.canChat("agent-b", now + 2000)).toBe(false);
  });

  it("cooldown expires after CHAT_COOLDOWN_AGENT_S", () => {
    const engine = new ChitChatEngine();
    const now = Date.now();

    const session = engine.tryStartChat("agent-a", "agent-b", "neutral", now)!;
    const interruptTime = now + 2000;
    engine.interrupt(session.sessionId, "agent-a", interruptTime);

    // Cooldown is 12s (CHAT_COOLDOWN_AGENT_S * 1000 = 12000ms)
    const cooldownMs = WORLD_LIFE_TUNABLES.CHAT_COOLDOWN_AGENT_S * 1000;

    // Still on cooldown just before expiry
    expect(engine.canChat("agent-a", interruptTime + cooldownMs - 1)).toBe(
      false,
    );

    // Cooldown expired
    expect(engine.canChat("agent-a", interruptTime + cooldownMs)).toBe(true);
    expect(engine.canChat("agent-b", interruptTime + cooldownMs)).toBe(true);
  });

  it("global cap blocks 3rd simultaneous chat", () => {
    const engine = new ChitChatEngine();
    const now = Date.now();

    // Start 2 chats (global cap is 2)
    const s1 = engine.tryStartChat("a1", "a2", "neutral", now);
    const s2 = engine.tryStartChat("b1", "b2", "neutral", now);

    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();

    // 3rd chat should be blocked by global cap
    const s3 = engine.tryStartChat("c1", "c2", "neutral", now);
    expect(s3).toBeNull();
  });

  it("chatProbForRoom returns correct probabilities per room type", () => {
    expect(chatProbForRoom("lounge")).toBe(0.6);
    expect(chatProbForRoom("kitchen")).toBe(0.45);
    expect(chatProbForRoom("desk")).toBe(0.3);
    expect(chatProbForRoom("server_room")).toBe(0);
    expect(chatProbForRoom("ops_center")).toBe(0);
    // Unknown room gets the default CHAT_PROB
    expect(chatProbForRoom("unknown_room")).toBe(
      WORLD_LIFE_TUNABLES.CHAT_PROB,
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: Sub-agent spawn -> tether -> completion (FSM + EventBus)
// ---------------------------------------------------------------------------

describe("Scenario 8 — State machine transitions for tool lifecycle", () => {
  it("ROOM_IDLE + tool_event -> ACTIVE_TOOL", () => {
    const result = nextState("ROOM_IDLE", { name: "tool_event" });
    expect(result).toBe("ACTIVE_TOOL");
  });

  it("ACTIVE_TOOL + tool_quiet_elapsed (sufficient dwell) -> ROOM_IDLE", () => {
    const result = nextState("ACTIVE_TOOL", {
      name: "tool_quiet_elapsed",
      dwellS: WORLD_LIFE_TUNABLES.TOOL_QUIET_S,
    });
    expect(result).toBe("ROOM_IDLE");
  });

  it("ACTIVE_TOOL + tool_quiet_elapsed (insufficient dwell) stays ACTIVE_TOOL", () => {
    const result = nextState("ACTIVE_TOOL", {
      name: "tool_quiet_elapsed",
      dwellS: WORLD_LIFE_TUNABLES.TOOL_QUIET_S - 1,
    });
    expect(result).toBe("ACTIVE_TOOL");
  });

  it("full lifecycle: ROOM_IDLE -> ACTIVE_TOOL -> ROOM_IDLE", () => {
    let state = nextState("ROOM_IDLE", { name: "tool_event" });
    expect(state).toBe("ACTIVE_TOOL");

    state = nextState(state, {
      name: "tool_quiet_elapsed",
      dwellS: WORLD_LIFE_TUNABLES.TOOL_QUIET_S,
    });
    expect(state).toBe("ROOM_IDLE");
  });

  it("tool_event preempts any state (hard preempt)", () => {
    const states = [
      "ROOM_IDLE",
      "ROOM_SIGNATURE",
      "MICRO_TRIP",
      "CHIT_CHAT",
      "IN_DIALOG",
      "SUMMONED",
      "TRAVELING",
    ] as const;

    for (const s of states) {
      expect(nextState(s, { name: "tool_event" })).toBe("ACTIVE_TOOL");
    }
  });
});

describe("Scenario 8 — EventBus sub-agent spawn and removal", () => {
  it("npc:spawned event fires with isSubAgent flag", () => {
    const bus = createEventBus();
    let received: { id: string; isSubAgent: boolean } | null = null;

    bus.on("npc:spawned", (payload) => {
      received = payload;
    });

    bus.emit("npc:spawned", {
      id: "sub-agent-1",
      col: 5,
      row: 3,
      isSubAgent: true,
    });

    expect(received).not.toBeNull();
    expect(received!.id).toBe("sub-agent-1");
    expect(received!.isSubAgent).toBe(true);
  });

  it("npc:removed event fires for sub-agent cleanup", () => {
    const bus = createEventBus();
    let removedId: string | null = null;

    bus.on("npc:removed", (payload) => {
      removedId = payload.id;
    });

    // Simulate sub-agent lifecycle: spawn then remove
    bus.emit("npc:spawned", {
      id: "sub-agent-1",
      col: 5,
      row: 3,
      isSubAgent: true,
    });

    bus.emit("npc:removed", { id: "sub-agent-1" });

    expect(removedId).toBe("sub-agent-1");
  });

  it("once listener only fires once", () => {
    const bus = createEventBus();
    let count = 0;

    bus.once("npc:removed", () => {
      count++;
    });

    bus.emit("npc:removed", { id: "sub-1" });
    bus.emit("npc:removed", { id: "sub-2" });

    expect(count).toBe(1);
  });
});

describe("Scenario 8 — NpcRegistry add/remove with sub-agent flag", () => {
  function createMockContext() {
    const bus = createEventBus();
    const makeMockSprite = () => {
      const sprite: any = {
        destroy: () => {},
        setTint: () => sprite,
        setDepth: () => sprite,
      };
      return sprite;
    };
    const makeMockRect = () => {
      const rect: any = {
        destroy: () => {},
        setDepth: () => rect,
      };
      return rect;
    };
    const scene = {
      add: {
        sprite: () => makeMockSprite(),
        rectangle: () => makeMockRect(),
      },
    } as any;
    return { scene, bus };
  }

  it("add with isSubAgent stores sub-agent state correctly", () => {
    const ctx = createMockContext();
    const registry = new NpcRegistry(ctx);

    const def = { id: "child-1", name: "Child Agent" } as any;
    const entity = registry.add(def, 4, 6, {
      isSubAgent: true,
      parentId: "parent-1",
    });

    expect(entity.state.isSubAgent).toBe(true);
    expect(entity.state.parentId).toBe("parent-1");
    expect(entity.state.restingScale).toBe(0.8);
  });

  it("add emits npc:spawned with isSubAgent=true", () => {
    const ctx = createMockContext();
    const registry = new NpcRegistry(ctx);
    let spawned: { id: string; isSubAgent: boolean } | null = null;

    ctx.bus.on("npc:spawned", (payload) => {
      spawned = payload;
    });

    const def = { id: "child-2", name: "Child Agent 2" } as any;
    registry.add(def, 2, 3, { isSubAgent: true, parentId: "parent-1" });

    expect(spawned).not.toBeNull();
    expect(spawned!.id).toBe("child-2");
    expect(spawned!.isSubAgent).toBe(true);
  });

  it("remove emits npc:removed event", () => {
    const ctx = createMockContext();
    const registry = new NpcRegistry(ctx);
    let removedId: string | null = null;

    ctx.bus.on("npc:removed", (payload) => {
      removedId = payload.id;
    });

    const def = { id: "child-3", name: "Child Agent 3" } as any;
    registry.add(def, 1, 1, { isSubAgent: true, parentId: "parent-1" });
    registry.remove("child-3");

    expect(removedId).toBe("child-3");
    expect(registry.has("child-3")).toBe(false);
  });
});
