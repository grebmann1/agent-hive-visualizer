import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AgentEvent } from "../../src/events/types";

// Mock the behavior registry and visual rules so pushEvent tests don't
// depend on the full Phaser-linked behavior table.
vi.mock("../../src/game/behaviors", () => ({
  matchBehavior: (_event: unknown) => ({
    id: "mock-behavior",
    room: "desk" as const,
    choreo: "idle" as const,
    describe: (e: { message: string }) => e.message || "mock bubble",
  }),
}));

vi.mock("../../src/events/visualRules", () => ({
  eventToVisualAction: (_event: unknown) => ({
    room: "desk" as const,
    animation: "idle" as const,
    bubble: "mock",
    face: "🙂",
  }),
}));

// Import AFTER mocks are registered
const { useAgentStore } = await import("../../src/stores/useAgentStore");

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type: "agent.tool.called",
    agentId: "agent-1",
    message: "Doing something",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("useAgentStore", () => {
  beforeEach(() => {
    useAgentStore.getState().reset();
  });

  describe("initial state", () => {
    it("starts with empty events", () => {
      expect(useAgentStore.getState().events).toEqual([]);
    });

    it("starts with default room and bubble", () => {
      const state = useAgentStore.getState();
      expect(state.currentRoom).toBe("desk");
      expect(state.currentBubble).toBe("Waiting for a task...");
      expect(state.currentAnimation).toBe("idle");
    });

    it("starts with empty activities", () => {
      expect(useAgentStore.getState().activities).toEqual({});
    });

    it("starts with empty usageByAgent", () => {
      expect(useAgentStore.getState().usageByAgent).toEqual({});
    });

    it("starts with empty errorByAgent", () => {
      expect(useAgentStore.getState().errorByAgent).toEqual({});
    });

    it("starts with empty sessionByAgent", () => {
      expect(useAgentStore.getState().sessionByAgent).toEqual({});
    });

    it("starts with empty eventsByAgent", () => {
      expect(useAgentStore.getState().eventsByAgent).toEqual({});
    });
  });

  describe("pushEvent — agent upsert (add new agent)", () => {
    it("adds an event to the global events array", () => {
      const event = makeEvent();
      useAgentStore.getState().pushEvent(event);
      expect(useAgentStore.getState().events).toHaveLength(1);
      expect(useAgentStore.getState().events[0]).toBe(event);
    });

    it("creates an activity entry for a new agent", () => {
      const event = makeEvent({ agentId: "new-agent" });
      useAgentStore.getState().pushEvent(event);
      const activity = useAgentStore.getState().activities["new-agent"];
      expect(activity).toBeDefined();
      expect(activity.agentId).toBe("new-agent");
      expect(activity.bubble).toBe("Doing something");
    });

    it("populates eventsByAgent for the agent", () => {
      const event = makeEvent({ agentId: "agent-x" });
      useAgentStore.getState().pushEvent(event);
      const agentEvents = useAgentStore.getState().eventsByAgent["agent-x"];
      expect(agentEvents).toHaveLength(1);
      expect(agentEvents[0]).toBe(event);
    });

    it("increments bubbleVersion", () => {
      const before = useAgentStore.getState().bubbleVersion;
      useAgentStore.getState().pushEvent(makeEvent());
      expect(useAgentStore.getState().bubbleVersion).toBe(before + 1);
    });
  });

  describe("pushEvent — agent upsert (update existing agent)", () => {
    it("updates an existing agent's activity", () => {
      useAgentStore.getState().pushEvent(makeEvent({ message: "First action" }));
      useAgentStore
        .getState()
        .pushEvent(makeEvent({ message: "Second action" }));

      const activity = useAgentStore.getState().activities["agent-1"];
      expect(activity.bubble).toBe("Second action");
    });

    it("appends to eventsByAgent for the same agent", () => {
      useAgentStore.getState().pushEvent(makeEvent({ message: "First" }));
      useAgentStore.getState().pushEvent(makeEvent({ message: "Second" }));
      const agentEvents = useAgentStore.getState().eventsByAgent["agent-1"];
      expect(agentEvents).toHaveLength(2);
    });

    it("updates currentBubble and currentTask", () => {
      useAgentStore
        .getState()
        .pushEvent(makeEvent({ message: "Updated message" }));
      const state = useAgentStore.getState();
      expect(state.currentBubble).toBe("Updated message");
      expect(state.currentTask).toBe("Updated message");
    });
  });

  describe("pushEvent — error handling", () => {
    it("sets errorByAgent on tool result with isError", () => {
      const event = makeEvent({
        type: "agent.tool.result",
        message: "Permission denied",
        metadata: { isError: true },
      });
      useAgentStore.getState().pushEvent(event);
      const err = useAgentStore.getState().errorByAgent["agent-1"];
      expect(err).toBeDefined();
      expect(err.message).toBe("Permission denied");
    });

    it("sets errorByAgent on agent.error event", () => {
      const event = makeEvent({
        type: "agent.error",
        message: "Something failed",
      });
      useAgentStore.getState().pushEvent(event);
      const err = useAgentStore.getState().errorByAgent["agent-1"];
      expect(err).toBeDefined();
      expect(err.message).toBe("Something failed");
    });

    it("clears stale error when a new tool_use arrives", () => {
      // First produce an error
      useAgentStore.getState().pushEvent(
        makeEvent({
          type: "agent.tool.result",
          message: "Error!",
          metadata: { isError: true },
        }),
      );
      expect(useAgentStore.getState().errorByAgent["agent-1"]).toBeDefined();

      // Then a new tool call clears it
      useAgentStore.getState().pushEvent(
        makeEvent({
          type: "agent.tool.called",
          message: "Reading file",
        }),
      );
      expect(
        useAgentStore.getState().errorByAgent["agent-1"],
      ).toBeUndefined();
    });
  });

  describe("pushEvent — thinking", () => {
    it("stores thinking text in thinkingByAgent", () => {
      const event = makeEvent({
        type: "agent.thinking",
        message: "I need to...",
        metadata: { text: "Planning the approach" },
      });
      useAgentStore.getState().pushEvent(event);
      expect(useAgentStore.getState().thinkingByAgent["agent-1"]).toBe(
        "Planning the approach",
      );
    });
  });

  describe("pushEvent — eventsByAgent ring buffer", () => {
    it("caps per-agent events at 100", () => {
      for (let i = 0; i < 110; i++) {
        useAgentStore
          .getState()
          .pushEvent(makeEvent({ message: `event-${i}` }));
      }
      const agentEvents = useAgentStore.getState().eventsByAgent["agent-1"];
      expect(agentEvents).toHaveLength(100);
      // Should keep the last 100 (indices 10..109)
      expect(agentEvents[0].message).toBe("event-10");
      expect(agentEvents[99].message).toBe("event-109");
    });
  });

  describe("applyUsageDelta", () => {
    it("creates usage entry for a new agent", () => {
      useAgentStore.getState().applyUsageDelta(
        "agent-1",
        { input: 100, output: 50, cacheCreate: 10, cacheRead: 5 },
        "2024-01-01T00:00:00Z",
      );
      const usage = useAgentStore.getState().usageByAgent["agent-1"];
      expect(usage).toEqual({
        input: 100,
        output: 50,
        cacheCreate: 10,
        cacheRead: 5,
        turns: 1,
        lastUpdate: "2024-01-01T00:00:00Z",
      });
    });

    it("accumulates usage across multiple deltas", () => {
      useAgentStore.getState().applyUsageDelta(
        "agent-1",
        { input: 100, output: 50, cacheCreate: 10, cacheRead: 5 },
        "2024-01-01T00:00:00Z",
      );
      useAgentStore.getState().applyUsageDelta(
        "agent-1",
        { input: 200, output: 100, cacheCreate: 20, cacheRead: 10 },
        "2024-01-01T00:01:00Z",
      );
      const usage = useAgentStore.getState().usageByAgent["agent-1"];
      expect(usage.input).toBe(300);
      expect(usage.output).toBe(150);
      expect(usage.cacheCreate).toBe(30);
      expect(usage.cacheRead).toBe(15);
      expect(usage.turns).toBe(2);
      expect(usage.lastUpdate).toBe("2024-01-01T00:01:00Z");
    });

    it("respects custom turnCount", () => {
      useAgentStore.getState().applyUsageDelta(
        "agent-1",
        { input: 500, output: 200, cacheCreate: 0, cacheRead: 0 },
        "2024-01-01T00:00:00Z",
        5,
      );
      expect(useAgentStore.getState().usageByAgent["agent-1"].turns).toBe(5);
    });
  });

  describe("applySession", () => {
    it("stores session info for an agent", () => {
      const info = {
        model: "claude-opus-4-20250514",
        sessionId: "sess-123",
        tools: ["Read", "Edit", "Bash"],
        startedAt: "2024-01-01T00:00:00Z",
      };
      useAgentStore.getState().applySession("agent-1", info);
      expect(useAgentStore.getState().sessionByAgent["agent-1"]).toEqual(info);
    });

    it("overwrites previous session info", () => {
      useAgentStore.getState().applySession("agent-1", {
        model: "old-model",
        sessionId: "old",
        tools: [],
        startedAt: "2024-01-01T00:00:00Z",
      });
      useAgentStore.getState().applySession("agent-1", {
        model: "new-model",
        sessionId: "new",
        tools: ["Bash"],
        startedAt: "2024-01-02T00:00:00Z",
      });
      expect(useAgentStore.getState().sessionByAgent["agent-1"].model).toBe(
        "new-model",
      );
    });
  });

  describe("clearError", () => {
    it("removes error for the specified agent", () => {
      useAgentStore.getState().pushEvent(
        makeEvent({
          type: "agent.error",
          agentId: "agent-1",
          message: "Error!",
        }),
      );
      expect(useAgentStore.getState().errorByAgent["agent-1"]).toBeDefined();

      useAgentStore.getState().clearError("agent-1");
      expect(
        useAgentStore.getState().errorByAgent["agent-1"],
      ).toBeUndefined();
    });

    it("is a no-op if agent has no error", () => {
      // Should not throw
      useAgentStore.getState().clearError("nonexistent");
      expect(useAgentStore.getState().errorByAgent).toEqual({});
    });

    it("does not affect other agents", () => {
      useAgentStore.getState().pushEvent(
        makeEvent({
          type: "agent.error",
          agentId: "agent-1",
          message: "Error 1",
        }),
      );
      useAgentStore.getState().pushEvent(
        makeEvent({
          type: "agent.error",
          agentId: "agent-2",
          message: "Error 2",
        }),
      );
      useAgentStore.getState().clearError("agent-1");
      expect(
        useAgentStore.getState().errorByAgent["agent-1"],
      ).toBeUndefined();
      expect(useAgentStore.getState().errorByAgent["agent-2"]).toBeDefined();
    });
  });

  describe("reset", () => {
    it("restores all state to initial values", () => {
      // Dirty the state
      useAgentStore.getState().pushEvent(makeEvent());
      useAgentStore.getState().applyUsageDelta(
        "agent-1",
        { input: 100, output: 50, cacheCreate: 0, cacheRead: 0 },
        "2024-01-01T00:00:00Z",
      );
      useAgentStore.getState().applySession("agent-1", {
        model: "x",
        sessionId: "x",
        tools: [],
        startedAt: "x",
      });

      useAgentStore.getState().reset();

      const state = useAgentStore.getState();
      expect(state.events).toEqual([]);
      expect(state.activities).toEqual({});
      expect(state.usageByAgent).toEqual({});
      expect(state.sessionByAgent).toEqual({});
      expect(state.errorByAgent).toEqual({});
      expect(state.eventsByAgent).toEqual({});
      expect(state.currentRoom).toBe("desk");
      expect(state.currentBubble).toBe("Waiting for a task...");
    });
  });

  describe("querying agents", () => {
    it("can query all active agents from activities keys", () => {
      useAgentStore
        .getState()
        .pushEvent(makeEvent({ agentId: "agent-1", message: "Working" }));
      useAgentStore
        .getState()
        .pushEvent(makeEvent({ agentId: "agent-2", message: "Reading" }));
      useAgentStore
        .getState()
        .pushEvent(makeEvent({ agentId: "agent-3", message: "Testing" }));

      const agentIds = Object.keys(useAgentStore.getState().activities);
      expect(agentIds).toContain("agent-1");
      expect(agentIds).toContain("agent-2");
      expect(agentIds).toContain("agent-3");
      expect(agentIds).toHaveLength(3);
    });

    it("can query a specific agent activity by id", () => {
      useAgentStore
        .getState()
        .pushEvent(makeEvent({ agentId: "agent-1", message: "Coding" }));
      const activity = useAgentStore.getState().activities["agent-1"];
      expect(activity).toBeDefined();
      expect(activity.agentId).toBe("agent-1");
      expect(activity.bubble).toBe("Coding");
    });

    it("returns undefined for unknown agent", () => {
      const activity = useAgentStore.getState().activities["nonexistent"];
      expect(activity).toBeUndefined();
    });
  });
});
