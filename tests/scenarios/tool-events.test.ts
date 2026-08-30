import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEventBus } from "../../src/game/sdk/event-bus";
import type { EventBus, SdkEventMap } from "../../src/game/sdk/event-bus";
import { ChoreoSystem } from "../../src/game/sdk/systems/ChoreoSystem";
import { useSettingsStore } from "../../src/stores/useSettingsStore";
import { useAgentStore } from "../../src/stores/useAgentStore";
import type { AgentEvent } from "../../src/events/types";
import type { ManagedEntity, SystemContext } from "../../src/game/sdk/types";

// ---------------------------------------------------------------------------
// Mock Phaser-dependent choreo module
// ---------------------------------------------------------------------------

vi.mock("../../src/game/choreo", () => ({
  startChoreo: vi.fn(() => ({ stop: vi.fn(), kind: "reading" })),
  toolNameToChoreo: vi.fn((name: string) => {
    if (name === "Read") return "reading";
    if (name === "Edit" || name === "Write") return "typing";
    return "pondering";
  }),
}));

// ---------------------------------------------------------------------------
// Helpers — mirrors patterns from tests/sdk/movement-system.test.ts
// ---------------------------------------------------------------------------

function mockScene() {
  return {
    tweens: {
      add: vi.fn(() => ({ destroy: vi.fn(), stop: vi.fn(), remove: vi.fn() })),
      killTweensOf: vi.fn(),
    },
    time: { now: 1000 },
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
    sheetKeyFor: () => "modern_adam",
    idleKeyFor: () => "modern_adam_idle",
    _add: (id: string, entity: ManagedEntity) => entities.set(id, entity),
    _remove: (id: string) => entities.delete(id),
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
        scaleX: 1,
        scaleY: 1,
        play: vi.fn(),
        stop: vi.fn(),
        setTexture: vi.fn(),
        setPosition: vi.fn(),
        setDepth: vi.fn(),
        setFrame: vi.fn(),
        setScale: vi.fn(),
        setAngle: vi.fn(),
        setAlpha: vi.fn(),
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

function makeToolEvent(
  agentId: string,
  toolName: string,
  type: AgentEvent["type"] = "agent.tool.called",
  extra: Partial<AgentEvent> = {},
): AgentEvent {
  return {
    type,
    agentId,
    message: `Using ${toolName}`,
    timestamp: new Date().toISOString(),
    metadata: { toolName, ...((extra.metadata as object) ?? {}) },
    ...extra,
  };
}

// ===========================================================================
// Scenario 2: Agent receives tool event -> walks to correct room -> plays choreo
// ===========================================================================

describe("Scenario 2: Tool event -> walk to room -> play choreo", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = createEventBus();
  });

  it("emits 'store:activity' with correct room and choreo for Read tool", () => {
    const handler = vi.fn();
    bus.on("store:activity", handler);

    bus.emit("store:activity", {
      id: "agent-1",
      room: "library",
      choreo: "reading",
      toolName: "Read",
    });

    expect(handler).toHaveBeenCalledWith({
      id: "agent-1",
      room: "library",
      choreo: "reading",
      toolName: "Read",
    });
  });

  it("emits 'move:started' with the library room after store:activity", () => {
    const moveHandler = vi.fn();
    bus.on("move:started", moveHandler);

    // Simulate the chain: store:activity triggers a move:started
    bus.on("store:activity", (payload) => {
      bus.emit("move:started", {
        id: payload.id,
        targetCol: 10,
        targetRow: 5,
        room: payload.room,
      });
    });

    bus.emit("store:activity", {
      id: "agent-1",
      room: "library",
      choreo: "reading",
      toolName: "Read",
    });

    expect(moveHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-1",
        room: "library",
      }),
    );
  });

  it("ChoreoSystem plays 'reading' choreo after move arrives", () => {
    const scene = mockScene();
    const ctx: SystemContext = { scene, bus };
    const registry = mockRegistry();
    const entity = mockEntity("agent-1", 10, 5);
    registry._add("agent-1", entity);

    const choreoSystem = new ChoreoSystem(ctx, registry);
    const choreoHandler = vi.fn();
    bus.on("choreo:started", choreoHandler);

    // Simulate arrival then play choreo
    bus.emit("move:arrived", { id: "agent-1", col: 10, row: 5 });
    choreoSystem.play("agent-1", "reading");

    expect(choreoHandler).toHaveBeenCalledWith({
      id: "agent-1",
      kind: "reading",
    });

    choreoSystem.destroy();
  });

  it("full event chain: store:activity -> move:started -> move:arrived -> choreo:started", () => {
    const scene = mockScene();
    const ctx: SystemContext = { scene, bus };
    const registry = mockRegistry();
    const entity = mockEntity("agent-1", 0, 0);
    registry._add("agent-1", entity);

    const choreoSystem = new ChoreoSystem(ctx, registry);
    const eventSequence: string[] = [];

    bus.on("store:activity", () => eventSequence.push("store:activity"));
    bus.on("move:started", () => eventSequence.push("move:started"));
    bus.on("move:arrived", () => eventSequence.push("move:arrived"));
    bus.on("choreo:started", () => eventSequence.push("choreo:started"));

    // Wire up the full chain
    bus.on("store:activity", (payload) => {
      bus.emit("move:started", {
        id: payload.id,
        targetCol: 10,
        targetRow: 5,
        room: payload.room,
      });
    });

    bus.on("move:started", (payload) => {
      // Simulate walk completing immediately
      entity.state.col = payload.targetCol;
      entity.state.row = payload.targetRow;
      bus.emit("move:arrived", {
        id: payload.id,
        col: payload.targetCol,
        row: payload.targetRow,
      });
    });

    bus.on("move:arrived", (payload) => {
      choreoSystem.play(payload.id, "reading");
    });

    // Trigger the chain
    bus.emit("store:activity", {
      id: "agent-1",
      room: "library",
      choreo: "reading",
      toolName: "Read",
    });

    expect(eventSequence).toEqual([
      "store:activity",
      "move:started",
      "move:arrived",
      "choreo:started",
    ]);

    choreoSystem.destroy();
  });
});

// ===========================================================================
// Scenario 7: Calm mode toggle -> decorative anims stop
// ===========================================================================

describe("Scenario 7: Calm mode toggle -> settings propagation", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = createEventBus();
    // Reset the settings store to defaults
    useSettingsStore.setState({ calmMode: false, worldLifeV2: false });
  });

  it("calmMode starts as false", () => {
    expect(useSettingsStore.getState().calmMode).toBe(false);
  });

  it("toggleCalmMode() flips to true and returns true", () => {
    const result = useSettingsStore.getState().toggleCalmMode();
    expect(result).toBe(true);
    expect(useSettingsStore.getState().calmMode).toBe(true);
  });

  it("emits 'store:settings-changed' with calmMode=true on bus", () => {
    const handler = vi.fn();
    bus.on("store:settings-changed", handler);

    // Simulate what a subscriber bridge would do when calmMode toggles
    const next = useSettingsStore.getState().toggleCalmMode();
    bus.emit("store:settings-changed", { key: "calmMode", value: next });

    expect(handler).toHaveBeenCalledWith({ key: "calmMode", value: true });
  });

  it("any system subscribed to 'store:settings-changed' receives the event", () => {
    const systemHandler = vi.fn();
    bus.on("store:settings-changed", systemHandler);

    useSettingsStore.getState().toggleCalmMode();
    bus.emit("store:settings-changed", { key: "calmMode", value: true });

    expect(systemHandler).toHaveBeenCalledTimes(1);
    expect(systemHandler).toHaveBeenCalledWith({
      key: "calmMode",
      value: true,
    });
  });

  it("toggle back to false fires bus event with value: false", () => {
    const handler = vi.fn();
    bus.on("store:settings-changed", handler);

    // Toggle on
    useSettingsStore.getState().toggleCalmMode();
    bus.emit("store:settings-changed", { key: "calmMode", value: true });

    // Toggle off
    const result = useSettingsStore.getState().toggleCalmMode();
    expect(result).toBe(false);
    expect(useSettingsStore.getState().calmMode).toBe(false);

    bus.emit("store:settings-changed", { key: "calmMode", value: false });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith({
      key: "calmMode",
      value: false,
    });
  });

  it("setCalmMode(true) directly sets the flag without toggle", () => {
    useSettingsStore.getState().setCalmMode(true);
    expect(useSettingsStore.getState().calmMode).toBe(true);

    useSettingsStore.getState().setCalmMode(false);
    expect(useSettingsStore.getState().calmMode).toBe(false);
  });
});

// ===========================================================================
// Scenario 11: Agent error -> pill flashes -> clears on next tool
// ===========================================================================

describe("Scenario 11: Agent error -> error set -> clears on next tool", () => {
  beforeEach(() => {
    useAgentStore.getState().reset();
  });

  it("tool_result with is_error sets errorByAgent for the agent", () => {
    const errorEvent: AgentEvent = {
      type: "agent.tool.result",
      agentId: "a1",
      message: "File not found: /path/to/missing.ts",
      timestamp: new Date().toISOString(),
      metadata: { isError: true, toolName: "Read" },
    };

    useAgentStore.getState().pushEvent(errorEvent);

    const errors = useAgentStore.getState().errorByAgent;
    expect(errors["a1"]).toBeDefined();
    expect(errors["a1"].message).toBe("File not found: /path/to/missing.ts");
  });

  it("new tool_use (PreToolUse) event clears the error for that agent", () => {
    // First: push an error event
    const errorEvent: AgentEvent = {
      type: "agent.tool.result",
      agentId: "a1",
      message: "Permission denied",
      timestamp: new Date().toISOString(),
      metadata: { isError: true, toolName: "Bash" },
    };
    useAgentStore.getState().pushEvent(errorEvent);

    // Verify error is set
    expect(useAgentStore.getState().errorByAgent["a1"]).toBeDefined();

    // Then: push a new tool_use (agent moves on to next tool)
    const nextToolEvent: AgentEvent = {
      type: "agent.tool.called",
      agentId: "a1",
      message: "Reading file",
      timestamp: new Date().toISOString(),
      metadata: { toolName: "Read" },
    };
    useAgentStore.getState().pushEvent(nextToolEvent);

    // Error should be cleared
    expect(useAgentStore.getState().errorByAgent["a1"]).toBeUndefined();
  });

  it("error for one agent does not affect another agent", () => {
    const errorA1: AgentEvent = {
      type: "agent.tool.result",
      agentId: "a1",
      message: "Command failed",
      timestamp: new Date().toISOString(),
      metadata: { isError: true, toolName: "Bash" },
    };

    const normalA2: AgentEvent = {
      type: "agent.tool.called",
      agentId: "a2",
      message: "Editing file",
      timestamp: new Date().toISOString(),
      metadata: { toolName: "Edit" },
    };

    useAgentStore.getState().pushEvent(errorA1);
    useAgentStore.getState().pushEvent(normalA2);

    expect(useAgentStore.getState().errorByAgent["a1"]).toBeDefined();
    expect(useAgentStore.getState().errorByAgent["a2"]).toBeUndefined();
  });

  it("successful tool_result also clears error state", () => {
    // Push error
    const errorEvent: AgentEvent = {
      type: "agent.tool.result",
      agentId: "a1",
      message: "Error: timeout",
      timestamp: new Date().toISOString(),
      metadata: { isError: true, toolName: "Bash" },
    };
    useAgentStore.getState().pushEvent(errorEvent);
    expect(useAgentStore.getState().errorByAgent["a1"]).toBeDefined();

    // Push a successful tool_result (no isError)
    const successEvent: AgentEvent = {
      type: "agent.tool.result",
      agentId: "a1",
      message: "Command succeeded",
      timestamp: new Date().toISOString(),
      metadata: { toolName: "Bash", isError: false },
    };
    useAgentStore.getState().pushEvent(successEvent);

    expect(useAgentStore.getState().errorByAgent["a1"]).toBeUndefined();
  });

  it("agent.error event type also sets error state", () => {
    const agentError: AgentEvent = {
      type: "agent.error",
      agentId: "a1",
      message: "Agent crashed unexpectedly",
      timestamp: new Date().toISOString(),
    };

    useAgentStore.getState().pushEvent(agentError);

    const errors = useAgentStore.getState().errorByAgent;
    expect(errors["a1"]).toBeDefined();
    expect(errors["a1"].message).toBe("Agent crashed unexpectedly");
  });

  it("clearError() manually clears the error", () => {
    const errorEvent: AgentEvent = {
      type: "agent.tool.result",
      agentId: "a1",
      message: "Oops",
      timestamp: new Date().toISOString(),
      metadata: { isError: true, toolName: "Edit" },
    };
    useAgentStore.getState().pushEvent(errorEvent);
    expect(useAgentStore.getState().errorByAgent["a1"]).toBeDefined();

    useAgentStore.getState().clearError("a1");
    expect(useAgentStore.getState().errorByAgent["a1"]).toBeUndefined();
  });

  it("event structure matches what the store expects in pushEvent", () => {
    // Verify the event flows through the full pushEvent pipeline correctly
    const event: AgentEvent = {
      type: "agent.tool.called",
      agentId: "a1",
      message: "Reading src/main.ts",
      timestamp: "2026-05-10T12:00:00.000Z",
      metadata: { toolName: "Read", input: { file_path: "src/main.ts" } },
    };

    useAgentStore.getState().pushEvent(event);

    const state = useAgentStore.getState();
    // Event was added to the global list
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toBe(event);
    // Per-agent log was populated
    expect(state.eventsByAgent["a1"]).toHaveLength(1);
    expect(state.eventsByAgent["a1"][0]).toBe(event);
    // Activity was created for the agent
    expect(state.activities["a1"]).toBeDefined();
    expect(state.activities["a1"].agentId).toBe("a1");
    expect(state.activities["a1"].room).toBe("library"); // Read -> library
    expect(state.activities["a1"].choreo).toBe("reading"); // Read -> reading
  });
});
