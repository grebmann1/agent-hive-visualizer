/**
 * Real Claude Hook Integration Tests
 *
 * These tests replay realistic Claude Code hook payloads through the
 * HookProvider → useAgentStore pipeline to verify the full data flow
 * produces correct events, room assignments, and choreo mappings.
 *
 * Each scenario simulates a real Claude session lifecycle using actual
 * hook_event_name values and tool payloads as they arrive from the
 * Electron hook-server bridge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HookProvider, type HookPayload } from "../../src/agents/hook-provider";
import type { AgentProviderAPI, AgentIdentity } from "../../src/agents/provider";
import { useAgentStore } from "../../src/stores/useAgentStore";
import { useNpcStore } from "../../src/stores/useNpcStore";
import type { AgentEvent } from "../../src/events/types";

// ---------------------------------------------------------------------------
// Test harness: captures all API calls the HookProvider makes
// ---------------------------------------------------------------------------

interface CapturedUpsert {
  agent: AgentIdentity;
  at: number;
}
interface CapturedEvent {
  event: AgentEvent;
  at: number;
}
interface CapturedRemoval {
  id: string;
  at: number;
}

function createMockAPI() {
  const upserts: CapturedUpsert[] = [];
  const events: CapturedEvent[] = [];
  const removals: CapturedRemoval[] = [];
  let seq = 0;

  const api: AgentProviderAPI = {
    upsertAgent(agent: AgentIdentity) {
      upserts.push({ agent, at: seq++ });
    },
    emitEvent(event: AgentEvent) {
      events.push({ event, at: seq++ });
      // Also push into the real store so room/choreo mapping is tested
      useAgentStore.getState().pushEvent(event);
    },
    removeAgent(id: string) {
      removals.push({ id, at: seq++ });
    },
  };

  return { api, upserts, events, removals };
}

// Simulate the window.agentquest.subscribeHookEvents bridge.
// Hook events are now wrapped in `{ seq, payload }` envelopes — this
// helper assigns a monotonic seq so the provider's dedupe gate sees
// strictly increasing values.
function setupFakeBridge() {
  let handler:
    | ((entry: { seq: number; payload: HookPayload }) => void)
    | null = null;
  let seq = 0;

  (globalThis as any).window = {
    agentquest: {
      isElectron: true,
      platform: "darwin",
      subscribeHookEvents: (
        cb: (entry: { seq: number; payload: HookPayload }) => void,
      ) => {
        handler = cb;
        return () => {
          handler = null;
        };
      },
      hooks: {
        // No buffered events to replay in the test harness.
        replay: () => Promise.resolve({ entries: [], latestSeq: 0 }),
      },
    },
  };

  return {
    fire(payload: HookPayload) {
      if (!handler) throw new Error("No hook handler registered");
      seq += 1;
      handler({ seq, payload });
    },
    get isSubscribed() {
      return handler !== null;
    },
  };
}

// ---------------------------------------------------------------------------
// Real payloads — modeled after actual Claude Code hook output
// ---------------------------------------------------------------------------

const SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const SESSION_ID_2 = "22222222-3333-4444-5555-666666777777";
const CWD = "/Users/dev/my-project";

function sessionStart(sessionId = SESSION_ID): HookPayload {
  return {
    hook_event_name: "SessionStart",
    session_id: sessionId,
    cwd: CWD,
    model: "claude-sonnet-4-5-20250514",
  };
}

function preToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId = SESSION_ID,
): HookPayload {
  return {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    cwd: CWD,
    tool_name: toolName,
    tool_input: toolInput,
    model: "claude-sonnet-4-5-20250514",
  };
}

function postToolUse(
  toolName: string,
  toolResponse: unknown,
  sessionId = SESSION_ID,
): HookPayload {
  return {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    cwd: CWD,
    tool_name: toolName,
    tool_response: toolResponse,
    model: "claude-sonnet-4-5-20250514",
  };
}

function postToolUseFailure(
  toolName: string,
  toolResponse: unknown,
  sessionId = SESSION_ID,
): HookPayload {
  return {
    hook_event_name: "PostToolUseFailure",
    session_id: sessionId,
    cwd: CWD,
    tool_name: toolName,
    tool_response: toolResponse,
    model: "claude-sonnet-4-5-20250514",
  };
}

function stop(sessionId = SESSION_ID): HookPayload {
  return {
    hook_event_name: "Stop",
    session_id: sessionId,
    cwd: CWD,
    stop_hook_active: true,
    model: "claude-sonnet-4-5-20250514",
  };
}

function sessionEnd(sessionId = SESSION_ID): HookPayload {
  return {
    hook_event_name: "SessionEnd",
    session_id: sessionId,
    cwd: CWD,
  };
}

function userPromptSubmit(
  prompt: string,
  sessionId = SESSION_ID,
): HookPayload {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    cwd: CWD,
    prompt,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Real Claude Hook Integration", () => {
  let provider: HookProvider;
  let mockAPI: ReturnType<typeof createMockAPI>;
  let bridge: ReturnType<typeof setupFakeBridge>;
  let stopProvider: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    useAgentStore.getState().reset();
    useNpcStore.setState({ dynamic: {} });

    bridge = setupFakeBridge();
    provider = new HookProvider();
    mockAPI = createMockAPI();
    stopProvider = provider.start(mockAPI.api);
  });

  afterEach(() => {
    stopProvider();
    vi.useRealTimers();
    delete (globalThis as any).window;
  });

  // =========================================================================
  // Scenario A: Full session lifecycle (start → tools → stop → end)
  // =========================================================================

  describe("Scenario A: Full session lifecycle", () => {
    it("SessionStart creates an agent with correct identity", () => {
      bridge.fire(sessionStart());

      expect(mockAPI.upserts).toHaveLength(1);
      const agent = mockAPI.upserts[0].agent;
      expect(agent.id).toBe(`session:${SESSION_ID.slice(0, 12)}`);
      expect(agent.displayName).toBe(`Claude-${SESSION_ID.slice(0, 4)}`);
      expect(agent.providerName).toBe("claude-hook");
      expect(agent.cwd).toBe(CWD);
      expect(agent.metadata).toMatchObject({
        sessionId: SESSION_ID,
        external: true,
        model: "claude-sonnet-4-5-20250514",
        provider: "claude",
      });
    });

    it("SessionStart emits agent.session event", () => {
      bridge.fire(sessionStart());

      expect(mockAPI.events).toHaveLength(1);
      const ev = mockAPI.events[0].event;
      expect(ev.type).toBe("agent.session");
      expect(ev.message).toContain(SESSION_ID.slice(0, 8));
      expect(ev.metadata).toMatchObject({
        sessionId: SESSION_ID,
        model: "claude-sonnet-4-5-20250514",
        cwd: CWD,
      });
    });

    it("SessionEnd removes the agent", () => {
      bridge.fire(sessionStart());
      bridge.fire(sessionEnd());

      expect(mockAPI.removals).toHaveLength(1);
      expect(mockAPI.removals[0].id).toBe(
        `session:${SESSION_ID.slice(0, 12)}`,
      );
    });

    it("full lifecycle: start → Read → PostToolUse → Stop → End", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("Read", { file_path: "/Users/dev/my-project/src/main.ts" }),
      );
      bridge.fire(
        postToolUse("Read", {
          content: [{ type: "text", text: "const x = 42;" }],
        }),
      );
      bridge.fire(stop());
      bridge.fire(sessionEnd());

      // 1 upsert (first contact)
      expect(mockAPI.upserts).toHaveLength(1);
      // 4 events: session, state.changed (PreToolUse), tool.result (PostToolUse), state.changed (Stop)
      expect(mockAPI.events).toHaveLength(4);
      expect(mockAPI.events[0].event.type).toBe("agent.session");
      expect(mockAPI.events[1].event.type).toBe("agent.state.changed");
      expect(mockAPI.events[1].event.state).toBe("reading_file");
      expect(mockAPI.events[2].event.type).toBe("agent.tool.result");
      expect(mockAPI.events[3].event.type).toBe("agent.state.changed");
      expect(mockAPI.events[3].event.state).toBe("summarizing");
      // 1 removal
      expect(mockAPI.removals).toHaveLength(1);
    });
  });

  // =========================================================================
  // Scenario B: Read tool → routes to library room
  // =========================================================================

  describe("Scenario B: Read tool → library room + reading choreo", () => {
    it("PreToolUse(Read) sets state to reading_file", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("Read", { file_path: "src/components/App.tsx" }),
      );

      const ev = mockAPI.events[1].event;
      expect(ev.type).toBe("agent.state.changed");
      expect(ev.state).toBe("reading_file");
      expect(ev.message).toBe("Read: src/components/App.tsx");
    });

    it("store maps Read to library room with reading choreo", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("Read", { file_path: "src/components/App.tsx" }),
      );

      const agentId = `session:${SESSION_ID.slice(0, 12)}`;
      const activity = useAgentStore.getState().activities[agentId];
      expect(activity).toBeDefined();
      expect(activity.room).toBe("library");
      expect(activity.choreo).toBe("reading");
      expect(activity.behaviorId).toBe("read-file");
    });

    it("successful PostToolUse(Read) emits tool.result without error", () => {
      bridge.fire(sessionStart());
      bridge.fire(preToolUse("Read", { file_path: "index.ts" }));
      bridge.fire(
        postToolUse("Read", {
          content: [{ type: "text", text: 'export default "hello";' }],
        }),
      );

      const resultEv = mockAPI.events[2].event;
      expect(resultEv.type).toBe("agent.tool.result");
      expect(resultEv.state).toBe("completed");
      expect(resultEv.message).toContain("OK:");
    });
  });

  // =========================================================================
  // Scenario C: Edit/Write tools → desk room + typing choreo
  // =========================================================================

  describe("Scenario C: Edit/Write tools → desk room + typing choreo", () => {
    it("PreToolUse(Edit) maps to desk + typing", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("Edit", {
          file_path: "src/app.ts",
          old_string: "foo",
          new_string: "bar",
        }),
      );

      const agentId = `session:${SESSION_ID.slice(0, 12)}`;
      const activity = useAgentStore.getState().activities[agentId];
      expect(activity.room).toBe("desk");
      expect(activity.choreo).toBe("typing");
      expect(activity.behaviorId).toBe("edit-file");
    });

    it("PreToolUse(Write) also maps to desk + typing", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("Write", {
          file_path: "src/new-file.ts",
          content: "export const x = 1;",
        }),
      );

      const agentId = `session:${SESSION_ID.slice(0, 12)}`;
      const activity = useAgentStore.getState().activities[agentId];
      expect(activity.room).toBe("desk");
      expect(activity.choreo).toBe("typing");
    });
  });

  // =========================================================================
  // Scenario D: Bash tool → desk room + hammering choreo
  // =========================================================================

  describe("Scenario D: Bash tool → desk + hammering choreo", () => {
    it("PreToolUse(Bash) maps to desk with hammering choreo", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("Bash", { command: "npm run build" }),
      );

      const agentId = `session:${SESSION_ID.slice(0, 12)}`;
      const activity = useAgentStore.getState().activities[agentId];
      expect(activity.room).toBe("desk");
      expect(activity.choreo).toBe("hammering");
      expect(activity.behaviorId).toBe("bash");
    });

    it("message includes the command", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("Bash", { command: "git status" }),
      );

      const ev = mockAPI.events[1].event;
      expect(ev.message).toBe("Bash: git status");
    });
  });

  // =========================================================================
  // Scenario E: Grep/Glob tools → library room + searching choreo
  // =========================================================================

  describe("Scenario E: Grep/Glob → library + searching choreo", () => {
    it("PreToolUse(Grep) maps to library with searching choreo", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("Grep", { pattern: "TODO", path: "src/" }),
      );

      const agentId = `session:${SESSION_ID.slice(0, 12)}`;
      const activity = useAgentStore.getState().activities[agentId];
      expect(activity.room).toBe("library");
      expect(activity.choreo).toBe("searching");
      expect(activity.behaviorId).toBe("search-code");
    });

    it("PreToolUse(Glob) also maps to library + searching", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("Glob", { pattern: "**/*.test.ts" }),
      );

      const agentId = `session:${SESSION_ID.slice(0, 12)}`;
      const activity = useAgentStore.getState().activities[agentId];
      expect(activity.room).toBe("library");
      expect(activity.choreo).toBe("searching");
    });
  });

  // =========================================================================
  // Scenario F: WebFetch/WebSearch → desk + browsing choreo
  // =========================================================================

  describe("Scenario F: WebFetch/WebSearch → desk + browsing choreo", () => {
    it("PreToolUse(WebFetch) maps to desk + browsing", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("WebFetch", { url: "https://docs.example.com/api" }),
      );

      const agentId = `session:${SESSION_ID.slice(0, 12)}`;
      const activity = useAgentStore.getState().activities[agentId];
      expect(activity.room).toBe("desk");
      expect(activity.choreo).toBe("browsing");
      expect(activity.behaviorId).toBe("search-web");
    });

    it("PreToolUse(WebSearch) maps to desk + browsing", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("WebSearch", { query: "react useEffect cleanup" }),
      );

      const agentId = `session:${SESSION_ID.slice(0, 12)}`;
      const activity = useAgentStore.getState().activities[agentId];
      expect(activity.room).toBe("desk");
      expect(activity.choreo).toBe("browsing");
    });
  });

  // =========================================================================
  // Scenario G: Task (sub-agent spawn) → desk + directing choreo
  // =========================================================================

  describe("Scenario G: Task tool → sub-agent linking", () => {
    it("PreToolUse(Task) maps parent to desk + directing choreo", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("Task", {
          description: "Review the implementation",
          subagent_type: "code-reviewer",
        }),
      );

      const agentId = `session:${SESSION_ID.slice(0, 12)}`;
      const activity = useAgentStore.getState().activities[agentId];
      expect(activity.room).toBe("desk");
      expect(activity.choreo).toBe("directing");
      expect(activity.behaviorId).toBe("task");
    });

    it("new session within 60s after Task is linked as child", () => {
      // Parent starts and fires a Task
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("Task", {
          description: "Do research",
          subagent_type: "researcher",
        }),
      );

      // 5 seconds later, a new session appears (the sub-agent)
      vi.advanceTimersByTime(5000);
      bridge.fire(sessionStart(SESSION_ID_2));

      // The child should be linked to the parent
      expect(mockAPI.upserts).toHaveLength(2);
      const childUpsert = mockAPI.upserts[1].agent;
      expect(childUpsert.metadata?.parentId).toBe(
        `session:${SESSION_ID.slice(0, 12)}`,
      );
      expect(childUpsert.metadata?.subagentType).toBe("researcher");
    });

    it("new session AFTER 60s window is NOT linked as child", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("Task", {
          description: "Late agent",
          subagent_type: "helper",
        }),
      );

      // Advance past the 60s window
      vi.advanceTimersByTime(61000);
      // Trigger sweep to clean up stale Task entries
      vi.advanceTimersByTime(30000);

      bridge.fire(sessionStart(SESSION_ID_2));

      const childUpsert = mockAPI.upserts[1].agent;
      expect(childUpsert.metadata?.parentId).toBeUndefined();
    });

    it("parallel Tasks each link to their own child", () => {
      const SESSION_CHILD_A = "aaaaaaaa-1111-2222-3333-444444444444";
      const SESSION_CHILD_B = "bbbbbbbb-1111-2222-3333-444444444444";

      bridge.fire(sessionStart());

      // Parent fires two Tasks in quick succession
      bridge.fire(
        preToolUse("Task", {
          description: "Research",
          subagent_type: "researcher",
        }),
      );
      bridge.fire(
        preToolUse("Task", {
          description: "Test",
          subagent_type: "tester",
        }),
      );

      vi.advanceTimersByTime(2000);
      bridge.fire(sessionStart(SESSION_CHILD_A));
      vi.advanceTimersByTime(1000);
      bridge.fire(sessionStart(SESSION_CHILD_B));

      // Both children should be linked to the same parent
      const childA = mockAPI.upserts[1].agent;
      const childB = mockAPI.upserts[2].agent;
      const parentId = `session:${SESSION_ID.slice(0, 12)}`;
      expect(childA.metadata?.parentId).toBe(parentId);
      expect(childB.metadata?.parentId).toBe(parentId);
      // Each gets its own subagentType
      // Note: the order depends on FIFO queue — first child gets first Task's type
      const types = [
        childA.metadata?.subagentType,
        childB.metadata?.subagentType,
      ];
      expect(types).toContain("researcher");
      expect(types).toContain("tester");
    });

    it("parallel Tasks across two parents preserve FIFO causality", () => {
      // Both parents are already long-running (typical: two terminals
      // each running claude). Parent A fires Task at t=0; Parent B
      // fires Task at t=5s. Two helper sessions arrive after — they
      // should be attributed FIFO: first helper → parent A's Task,
      // second helper → parent B's Task. Picking the most-recent
      // queued entry instead would silently mis-attribute.
      const PARENT_A = SESSION_ID;
      const PARENT_B = SESSION_ID_2;
      bridge.fire(sessionStart(PARENT_A));
      bridge.fire(sessionStart(PARENT_B));
      // Both parents have been running for a while (well past the
      // orphan-child window) before either fires Task — the typical
      // case. Without this delay, the parents would still be in the
      // orphan buffer and the first Task would treat the other parent
      // as its own helper.
      vi.advanceTimersByTime(1_000);

      // Parents fire Tasks 5s apart.
      bridge.fire(
        preToolUse("Task", { subagent_type: "alpha" }, PARENT_A),
      );
      vi.advanceTimersByTime(5_000);
      bridge.fire(
        preToolUse("Task", { subagent_type: "beta" }, PARENT_B),
      );

      // First helper arrives — must be attributed to parent A (oldest queued).
      const CHILD_1 = "33333333-4444-5555-6666-777777777777";
      bridge.fire(sessionStart(CHILD_1));
      const childOneUpsert = mockAPI.upserts.find(
        (u) => u.agent.id === `session:${CHILD_1.slice(0, 12)}`,
      )!.agent;
      expect(childOneUpsert.metadata?.parentId).toBe(
        `session:${PARENT_A.slice(0, 12)}`,
      );
      expect(childOneUpsert.metadata?.subagentType).toBe("alpha");

      // Second helper — must be attributed to parent B.
      const CHILD_2 = "44444444-5555-6666-7777-888888888888";
      bridge.fire(sessionStart(CHILD_2));
      const childTwoUpsert = mockAPI.upserts.find(
        (u) => u.agent.id === `session:${CHILD_2.slice(0, 12)}`,
      )!.agent;
      expect(childTwoUpsert.metadata?.parentId).toBe(
        `session:${PARENT_B.slice(0, 12)}`,
      );
      expect(childTwoUpsert.metadata?.subagentType).toBe("beta");
    });

    it("child SessionStart that arrives before parent's Task is linked retroactively", () => {
      // The wrapper script fires hooks via two backgrounded curls,
      // so the child's SessionStart can land before the parent's
      // Task PreToolUse. The orphan-child buffer should hold the
      // child briefly and re-upsert with parentId once Task arrives.
      bridge.fire(sessionStart(SESSION_ID));

      // Brand-new child fires first — no Task in flight.
      const CHILD = "33333333-4444-5555-6666-777777777777";
      bridge.fire(sessionStart(CHILD));
      const childInitial = mockAPI.upserts.find(
        (u) => u.agent.id === `session:${CHILD.slice(0, 12)}`,
      );
      expect(childInitial?.agent.metadata?.parentId).toBeUndefined();

      // Parent's Task PreToolUse arrives 200ms later.
      vi.advanceTimersByTime(200);
      bridge.fire(
        preToolUse("Task", { subagent_type: "researcher" }, SESSION_ID),
      );

      // The most recent upsert for the child should now carry parentId.
      const childUpserts = mockAPI.upserts.filter(
        (u) => u.agent.id === `session:${CHILD.slice(0, 12)}`,
      );
      expect(childUpserts.length).toBeGreaterThanOrEqual(2);
      const lastChild = childUpserts[childUpserts.length - 1];
      expect(lastChild.agent.metadata?.parentId).toBe(
        `session:${SESSION_ID.slice(0, 12)}`,
      );
      expect(lastChild.agent.metadata?.subagentType).toBe("researcher");
    });
  });

  // =========================================================================
  // Scenario H: Tool errors (PostToolUseFailure + isError responses)
  // =========================================================================

  describe("Scenario H: Tool error handling", () => {
    it("PostToolUseFailure emits tool.result with failed state", () => {
      bridge.fire(sessionStart());
      bridge.fire(preToolUse("Bash", { command: "rm -rf /" }));
      bridge.fire(
        postToolUseFailure("Bash", {
          content: [{ type: "text", text: "Permission denied" }],
        }),
      );

      const ev = mockAPI.events[2].event;
      expect(ev.type).toBe("agent.tool.result");
      expect(ev.state).toBe("failed");
      expect(ev.message).toContain("Error:");
      expect(ev.message).toContain("Permission denied");
      expect(ev.metadata).toMatchObject({ isError: true, toolName: "Bash" });
    });

    it("PostToolUse with is_error: true in response is also treated as error", () => {
      bridge.fire(sessionStart());
      bridge.fire(preToolUse("Read", { file_path: "/nonexistent.ts" }));
      bridge.fire(
        postToolUse("Read", {
          is_error: true,
          content: [{ type: "text", text: "File not found: /nonexistent.ts" }],
        }),
      );

      const ev = mockAPI.events[2].event;
      expect(ev.type).toBe("agent.tool.result");
      expect(ev.state).toBe("failed");
      expect(ev.metadata).toMatchObject({ isError: true });
    });

    it("error sets errorByAgent in the store", () => {
      bridge.fire(sessionStart());
      bridge.fire(preToolUse("Bash", { command: "false" }));
      bridge.fire(
        postToolUseFailure("Bash", {
          content: [{ type: "text", text: "Command exited with code 1" }],
        }),
      );

      const agentId = `session:${SESSION_ID.slice(0, 12)}`;
      const error = useAgentStore.getState().errorByAgent[agentId];
      expect(error).toBeDefined();
      expect(error.message).toContain("Command exited with code 1");
    });

    it("next successful tool clears the error", () => {
      bridge.fire(sessionStart());
      bridge.fire(preToolUse("Bash", { command: "false" }));
      bridge.fire(
        postToolUseFailure("Bash", {
          content: [{ type: "text", text: "exit 1" }],
        }),
      );

      const agentId = `session:${SESSION_ID.slice(0, 12)}`;
      expect(useAgentStore.getState().errorByAgent[agentId]).toBeDefined();

      // Agent moves on to next tool
      bridge.fire(preToolUse("Read", { file_path: "package.json" }));

      // Error should be cleared by the new tool_use event via agent.state.changed
      // Note: state.changed doesn't clear error — only tool.called or tool.result does.
      // The hook provider emits "agent.state.changed", not "agent.tool.called".
      // Let's check if it's actually cleared by a successful PostToolUse:
      bridge.fire(
        postToolUse("Read", {
          content: [{ type: "text", text: '{ "name": "my-project" }' }],
        }),
      );

      expect(useAgentStore.getState().errorByAgent[agentId]).toBeUndefined();
    });
  });

  // =========================================================================
  // Scenario I: UserPromptSubmit → thinking event with fromUser flag
  // =========================================================================

  describe("Scenario I: UserPromptSubmit handling", () => {
    it("emits agent.thinking event with fromUser flag", () => {
      bridge.fire(sessionStart());
      bridge.fire(userPromptSubmit("Fix the login bug"));

      const ev = mockAPI.events[1].event;
      expect(ev.type).toBe("agent.thinking");
      expect(ev.state).toBe("thinking");
      expect(ev.message).toContain("You asked: Fix the login bug");
      expect(ev.metadata).toMatchObject({ fromUser: true });
    });

    it("long prompts are truncated to 120 chars in message", () => {
      const longPrompt = "A".repeat(200);
      bridge.fire(sessionStart());
      bridge.fire(userPromptSubmit(longPrompt));

      const ev = mockAPI.events[1].event;
      expect(ev.message.length).toBeLessThanOrEqual("You asked: ".length + 120);
    });

    it("empty prompt gets fallback message", () => {
      bridge.fire(sessionStart());
      bridge.fire(userPromptSubmit(""));

      const ev = mockAPI.events[1].event;
      expect(ev.message).toBe("User asked something");
    });
  });

  // =========================================================================
  // Scenario J: Stop event → summarizing state
  // =========================================================================

  describe("Scenario J: Stop event handling", () => {
    it("Stop emits state.changed with summarizing state", () => {
      bridge.fire(sessionStart());
      bridge.fire(stop());

      const ev = mockAPI.events[1].event;
      expect(ev.type).toBe("agent.state.changed");
      expect(ev.state).toBe("summarizing");
      expect(ev.message).toBe("(turn complete)");
    });

    it("Stop does NOT remove the agent (only SessionEnd does)", () => {
      bridge.fire(sessionStart());
      bridge.fire(stop());

      expect(mockAPI.removals).toHaveLength(0);
    });
  });

  // =========================================================================
  // Scenario K: Multi-tool session (realistic coding workflow)
  // =========================================================================

  describe("Scenario K: Realistic multi-tool coding workflow", () => {
    it("Read → Edit → Bash → Read → Stop produces correct room sequence", () => {
      const agentId = `session:${SESSION_ID.slice(0, 12)}`;

      bridge.fire(sessionStart());

      // 1. Read the file
      bridge.fire(preToolUse("Read", { file_path: "src/app.ts" }));
      expect(useAgentStore.getState().activities[agentId].room).toBe("library");

      bridge.fire(
        postToolUse("Read", {
          content: [{ type: "text", text: "export const app = {};" }],
        }),
      );
      // PostToolUse is passive — room stays at library
      expect(useAgentStore.getState().activities[agentId].room).toBe("library");

      // 2. Edit the file
      bridge.fire(
        preToolUse("Edit", {
          file_path: "src/app.ts",
          old_string: "export const app = {};",
          new_string: 'export const app = { name: "hello" };',
        }),
      );
      expect(useAgentStore.getState().activities[agentId].room).toBe("desk");
      expect(useAgentStore.getState().activities[agentId].choreo).toBe(
        "typing",
      );

      bridge.fire(postToolUse("Edit", { output: "OK" }));

      // 3. Run tests
      bridge.fire(preToolUse("Bash", { command: "npm test" }));
      expect(useAgentStore.getState().activities[agentId].room).toBe("desk");
      expect(useAgentStore.getState().activities[agentId].choreo).toBe(
        "hammering",
      );

      bridge.fire(
        postToolUse("Bash", { stdout: "Tests passed: 42/42" }),
      );

      // 4. Read test output for review
      bridge.fire(
        preToolUse("Read", { file_path: "test-results.json" }),
      );
      expect(useAgentStore.getState().activities[agentId].room).toBe("library");

      // 5. Turn complete
      bridge.fire(stop());
    });

    it("event log accumulates all events for the agent", () => {
      const agentId = `session:${SESSION_ID.slice(0, 12)}`;

      bridge.fire(sessionStart());
      bridge.fire(preToolUse("Read", { file_path: "a.ts" }));
      bridge.fire(postToolUse("Read", { text: "content" }));
      bridge.fire(preToolUse("Edit", { file_path: "a.ts" }));
      bridge.fire(postToolUse("Edit", { output: "ok" }));
      bridge.fire(stop());

      const events = useAgentStore.getState().eventsByAgent[agentId];
      // session + 2 PreToolUse + 2 PostToolUse + Stop = 6
      expect(events).toHaveLength(6);
    });
  });

  // =========================================================================
  // Scenario L: Embedded terminal agent (agentquest_terminal_id)
  // =========================================================================

  describe("Scenario L: Embedded terminal agents", () => {
    it("terminal agents use term: prefix for id", () => {
      bridge.fire({
        hook_event_name: "SessionStart",
        session_id: SESSION_ID,
        agentquest_terminal_id: "term-abc123",
        cwd: CWD,
        model: "claude-sonnet-4-5-20250514",
      });

      expect(mockAPI.upserts).toHaveLength(1);
      expect(mockAPI.upserts[0].agent.id).toBe("term:term-abc123");
      expect(mockAPI.upserts[0].agent.metadata?.terminalId).toBe("term-abc123");
      expect(mockAPI.upserts[0].agent.metadata?.external).toBe(false);
    });

    it("external sessions (no terminal id) have external: true", () => {
      bridge.fire(sessionStart());

      expect(mockAPI.upserts[0].agent.metadata?.external).toBe(true);
    });
  });

  // =========================================================================
  // Scenario M: Idle sweep removes stale agents after 10 minutes
  // =========================================================================

  describe("Scenario M: Idle sweep timeout", () => {
    it("agent is removed after 10 minutes of silence", () => {
      bridge.fire(sessionStart());
      expect(mockAPI.removals).toHaveLength(0);

      // Advance past idle timeout (10 min) + one sweep interval (30s)
      vi.advanceTimersByTime(10 * 60 * 1000 + 30 * 1000);

      expect(mockAPI.removals).toHaveLength(1);
      expect(mockAPI.removals[0].id).toBe(
        `session:${SESSION_ID.slice(0, 12)}`,
      );
    });

    it("agent activity resets the idle timer", () => {
      bridge.fire(sessionStart());

      // Activity at 5 minutes
      vi.advanceTimersByTime(5 * 60 * 1000);
      bridge.fire(preToolUse("Read", { file_path: "x.ts" }));

      // At 9 minutes from last activity — should still be alive
      vi.advanceTimersByTime(9 * 60 * 1000);
      expect(mockAPI.removals).toHaveLength(0);

      // At 10 minutes + sweep — now removed
      vi.advanceTimersByTime(1 * 60 * 1000 + 30 * 1000);
      expect(mockAPI.removals).toHaveLength(1);
    });
  });

  // =========================================================================
  // Scenario N: TodoWrite → desk + planning choreo
  // =========================================================================

  describe("Scenario N: TodoWrite → desk + planning choreo", () => {
    it("PreToolUse(TodoWrite) maps to desk + planning", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("TodoWrite", {
          todos: [
            { id: "1", content: "Implement login", status: "in_progress" },
          ],
        }),
      );

      const agentId = `session:${SESSION_ID.slice(0, 12)}`;
      const activity = useAgentStore.getState().activities[agentId];
      expect(activity.room).toBe("desk");
      expect(activity.choreo).toBe("planning");
      expect(activity.behaviorId).toBe("planning");
    });
  });

  // =========================================================================
  // Scenario O: Unknown tool → thinking state → desk fallback
  // =========================================================================

  describe("Scenario O: Unknown/custom tools → fallback behavior", () => {
    it("unknown tool name maps to thinking state", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("CustomMcpTool", { input: "test" }),
      );

      const ev = mockAPI.events[1].event;
      expect(ev.state).toBe("thinking");
    });

    it("store maps unknown tool to fallback behavior (desk + idle-bob)", () => {
      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("SomeRandomTool", { data: "whatever" }),
      );

      const agentId = `session:${SESSION_ID.slice(0, 12)}`;
      const activity = useAgentStore.getState().activities[agentId];
      expect(activity.room).toBe("desk");
      expect(activity.behaviorId).toBe("fallback");
    });
  });

  // =========================================================================
  // Scenario P: Duplicate sessions don't re-upsert
  // =========================================================================

  describe("Scenario P: Duplicate session handling", () => {
    it("second payload from same session does NOT re-upsert", () => {
      bridge.fire(sessionStart());
      bridge.fire(preToolUse("Read", { file_path: "a.ts" }));
      bridge.fire(preToolUse("Edit", { file_path: "b.ts" }));

      // Only one upsert — the initial registration
      expect(mockAPI.upserts).toHaveLength(1);
    });

    it("two different sessions create two separate agents", () => {
      bridge.fire(sessionStart(SESSION_ID));
      bridge.fire(sessionStart(SESSION_ID_2));

      expect(mockAPI.upserts).toHaveLength(2);
      expect(mockAPI.upserts[0].agent.id).not.toBe(
        mockAPI.upserts[1].agent.id,
      );
    });
  });

  // =========================================================================
  // Scenario Q: SubagentStop → removes child + emits on parent
  // =========================================================================

  describe("Scenario Q: SubagentStop handling", () => {
    it("SubagentStop removes the child agent", () => {
      // Simulate parent + child in the NPC store
      const parentId = `session:${SESSION_ID.slice(0, 12)}`;
      const childId = `session:${SESSION_ID_2.slice(0, 12)}`;

      bridge.fire(sessionStart());
      bridge.fire(
        preToolUse("Task", { subagent_type: "researcher" }),
      );

      vi.advanceTimersByTime(2000);
      bridge.fire(sessionStart(SESSION_ID_2));

      // Now fire SubagentStop for the child
      // First, put the child in the NPC store with parentId
      useNpcStore.setState({
        dynamic: {
          [childId]: {
            id: childId,
            name: "Child",
            dynamic: true,
            parentId,
            home: "desk",
          } as any,
        },
      });

      bridge.fire({
        hook_event_name: "SubagentStop",
        session_id: SESSION_ID_2,
        cwd: CWD,
        prompt: "Research complete — found 3 relevant files",
      });

      // Child should be removed
      const childRemoval = mockAPI.removals.find((r) => r.id === childId);
      expect(childRemoval).toBeDefined();
    });
  });

  // =========================================================================
  // Scenario R: Tool response summarization
  // =========================================================================

  describe("Scenario R: Tool response summarization", () => {
    it("content array is stitched into text", () => {
      bridge.fire(sessionStart());
      bridge.fire(preToolUse("Read", { file_path: "a.ts" }));
      bridge.fire(
        postToolUse("Read", {
          content: [
            { type: "text", text: "line 1\n" },
            { type: "text", text: "line 2\n" },
          ],
        }),
      );

      const ev = mockAPI.events[2].event;
      expect(ev.message).toContain("line 1");
      expect(ev.message).toContain("line 2");
    });

    it("stdout field is used for Bash responses", () => {
      bridge.fire(sessionStart());
      bridge.fire(preToolUse("Bash", { command: "echo hi" }));
      bridge.fire(postToolUse("Bash", { stdout: "hi\n" }));

      const ev = mockAPI.events[2].event;
      expect(ev.message).toContain("hi");
    });

    it("output field is used for Edit responses", () => {
      bridge.fire(sessionStart());
      bridge.fire(preToolUse("Edit", { file_path: "x.ts" }));
      bridge.fire(postToolUse("Edit", { output: "Applied 1 edit" }));

      const ev = mockAPI.events[2].event;
      expect(ev.message).toContain("Applied 1 edit");
    });

    it("null response produces empty message gracefully", () => {
      bridge.fire(sessionStart());
      bridge.fire(preToolUse("Edit", { file_path: "x.ts" }));
      bridge.fire(postToolUse("Edit", null));

      const ev = mockAPI.events[2].event;
      expect(ev.message).toBe("Tool finished.");
    });
  });

  // =========================================================================
  // Scenario S: Agent identity naming
  // =========================================================================

  describe("Scenario S: Agent naming conventions", () => {
    it("external session agent gets Claude-XXXX display name", () => {
      bridge.fire(sessionStart());

      const agent = mockAPI.upserts[0].agent;
      expect(agent.displayName).toBe(`Claude-${SESSION_ID.slice(0, 4)}`);
    });

    it("terminal agent gets Claude-XXXX from terminal suffix", () => {
      bridge.fire({
        hook_event_name: "SessionStart",
        session_id: SESSION_ID,
        agentquest_terminal_id: "my-terminal-id-xyz",
        cwd: CWD,
      });

      const agent = mockAPI.upserts[0].agent;
      // Uses last 4 chars of the agentId (term:my-terminal-id-xyz → last 4 of that)
      expect(agent.displayName).toBe("Claude--xyz");
    });
  });
});
