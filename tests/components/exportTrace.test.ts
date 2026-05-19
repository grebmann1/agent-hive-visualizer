import { describe, expect, it } from "vitest";
import { buildTraceJsonl } from "../../src/components/exportTrace";
import type { AgentEvent } from "../../src/events/types";

const baseEvents: AgentEvent[] = [
  {
    type: "agent.session",
    agentId: "session:abc",
    timestamp: "2026-05-14T00:00:00.000Z",
    message: "Session abc",
    metadata: {
      sessionId: "abc",
      model: "claude-sonnet-4-5-20250514",
    },
  },
  {
    type: "agent.thinking",
    agentId: "session:abc",
    state: "thinking",
    timestamp: "2026-05-14T00:00:01.000Z",
    message: "You asked: refactor the login flow",
    metadata: {
      text: "refactor the login flow and remove the deprecated middleware",
      fromUser: true,
    },
  },
  {
    type: "agent.state.changed",
    agentId: "session:abc",
    state: "reading_file",
    timestamp: "2026-05-14T00:00:02.000Z",
    message: "Read: src/auth.ts",
    metadata: {
      toolName: "Read",
      toolUseId: "tu_1",
      input: { file_path: "src/auth.ts" },
    },
  },
  {
    type: "agent.tool.result",
    agentId: "session:abc",
    state: "completed",
    timestamp: "2026-05-14T00:00:03.000Z",
    message: "OK: file contents",
    metadata: {
      toolName: "Read",
      toolUseId: "tu_1",
      isError: false,
      resultText: "export function login() { /* secret token: hunter2 */ }",
    },
  },
];

function parseLines(jsonl: string): Array<Record<string, unknown>> {
  return jsonl
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("buildTraceJsonl", () => {
  it("emits a header + one row per event", () => {
    const out = buildTraceJsonl({
      agentId: "session:abc",
      displayName: "Claude-abc",
      events: baseEvents,
      includePrompts: false,
    });
    const lines = parseLines(out);
    expect(lines).toHaveLength(1 + baseEvents.length);
    expect(lines[0]._kind).toBe("agentquest.trace.v1");
    expect(lines[0].displayName).toBe("Claude-abc");
    expect(lines[0].includesPrompts).toBe(false);
    expect(lines[0].eventCount).toBe(4);
  });

  it("redacts prompt + tool input/output by default", () => {
    const out = buildTraceJsonl({
      agentId: "session:abc",
      displayName: "Claude-abc",
      events: baseEvents,
      includePrompts: false,
    });
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("refactor the login flow");
    expect(out).not.toContain("export function login");
    // But the *behavior* metadata is still present.
    expect(out).toContain("Read");
    expect(out).toContain("reading_file");
    expect(out).toContain("agent.tool.result");
  });

  it("includes prompt + tool input/output when opted in", () => {
    const out = buildTraceJsonl({
      agentId: "session:abc",
      displayName: "Claude-abc",
      events: baseEvents,
      includePrompts: true,
    });
    expect(out).toContain("refactor the login flow");
    expect(out).toContain("hunter2");
    expect(out).toContain("src/auth.ts");
  });

  it("preserves parentId on every row when set on the npc", () => {
    const out = buildTraceJsonl({
      agentId: "session:abc",
      displayName: "Claude-abc",
      events: baseEvents.slice(2, 3),
      npc: {
        id: "session:abc",
        name: "Claude-abc",
        parentId: "session:parent",
        cwd: "/x",
      } as never, // partial — buildTraceJsonl only reads parentId/cwd/pid/subagentType
      includePrompts: false,
    });
    const lines = parseLines(out);
    expect(lines[0].parentId).toBe("session:parent");
    expect(lines[1].parentId).toBe("session:parent");
  });

  it("truncates long prompt text", () => {
    const huge = "x".repeat(8000);
    const out = buildTraceJsonl({
      agentId: "session:abc",
      displayName: "Claude-abc",
      events: [
        {
          type: "agent.thinking",
          agentId: "session:abc",
          state: "thinking",
          timestamp: "2026-05-14T00:00:00.000Z",
          message: "You asked: …",
          metadata: { text: huge, fromUser: true },
        },
      ],
      includePrompts: true,
    });
    expect(out).toContain("[truncated]");
  });
});
