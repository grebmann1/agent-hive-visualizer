// Exports an agent's recent event stream as JSONL.
//
// The store keeps a per-agent ring buffer of the last 100 AgentEvents
// (`useAgentStore.eventsByAgent[agentId]`). This is the only event
// trace AgentQuest holds — nothing is persisted to disk by the hook
// pipeline. The export gives users a way to grab that buffer for
// debugging, sharing with a teammate, or pasting into a bug report.
//
// Privacy posture: prompt + tool input/output text is *only* included
// when the user has opted in via `exportIncludePrompts`. The default
// trace contains tool names, timestamps, durations, error flags, the
// state machine, and the parent/child topology — enough to diagnose
// the agent's *behavior* without leaking the data the agent acted on.

import type { AgentEvent } from "../events/types";
import type { AgentUsage, AgentSessionInfo } from "../stores/useAgentStore";
import type { DynamicNpc } from "../stores/useNpcStore";

export interface ExportContext {
  agentId: string;
  displayName: string;
  events: AgentEvent[];
  npc?: DynamicNpc | null;
  session?: AgentSessionInfo | null;
  usage?: AgentUsage | null;
  includePrompts: boolean;
}

interface ExportedRow {
  timestamp: string;
  agentId: string;
  parentId?: string;
  type: AgentEvent["type"];
  state?: AgentEvent["state"];
  message?: string;
  toolName?: string;
  toolUseId?: string;
  isError?: boolean;
  fromUser?: boolean;
  subagentType?: string;
  childAgentId?: string;
  // Only populated when includePrompts is true.
  input?: unknown;
  resultText?: string;
  text?: string;
  summary?: string;
}

interface MetaShape {
  toolName?: string;
  toolUseId?: string;
  isError?: boolean;
  fromUser?: boolean;
  subagentType?: string;
  childAgentId?: string;
  input?: unknown;
  resultText?: string;
  text?: string;
  summary?: string;
}

const TEXT_CAP = 4096;

function truncate(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + "…[truncated]" : s;
}

function rowFor(
  event: AgentEvent,
  parentId: string | undefined,
  includePrompts: boolean,
): ExportedRow {
  const meta = (event.metadata ?? {}) as MetaShape;
  // The `message` field on an AgentEvent often paraphrases prompt or
  // tool-output content (e.g. "You asked: refactor the login flow",
  // "OK: file contents — export function login() …"). Treat it as
  // sensitive whenever the source content is sensitive: drop it when
  // includePrompts is false and the event carries user-prompt or
  // tool-result text. State-only events (PreToolUse with just a tool
  // name and file path) keep their message — file paths aren't the
  // privacy concern, the text inside the file is.
  const messageIsDerivedFromContent =
    meta.fromUser === true ||
    typeof meta.resultText === "string" ||
    (event.type === "agent.thinking" && typeof meta.text === "string");
  const safeMessage =
    !includePrompts && messageIsDerivedFromContent ? undefined : event.message;
  const row: ExportedRow = {
    timestamp: event.timestamp,
    agentId: event.agentId,
    parentId,
    type: event.type,
    state: event.state,
    message: safeMessage,
    toolName: meta.toolName,
    toolUseId: meta.toolUseId,
    isError: meta.isError,
    fromUser: meta.fromUser,
    subagentType: meta.subagentType,
    childAgentId: meta.childAgentId,
  };
  if (includePrompts) {
    row.input = meta.input;
    row.resultText = truncate(meta.resultText);
    row.text = truncate(meta.text);
    row.summary = truncate(meta.summary);
  }
  return row;
}

function safeFilename(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

export function buildTraceJsonl(ctx: ExportContext): string {
  const lines: string[] = [];
  // Header line — JSONL convention: each line is its own JSON object.
  // The header carries metadata about the export so the file is
  // self-describing without requiring a sibling manifest.
  lines.push(
    JSON.stringify({
      _kind: "agentquest.trace.v1",
      exportedAt: new Date().toISOString(),
      agentId: ctx.agentId,
      displayName: ctx.displayName,
      sessionId: ctx.session?.sessionId,
      model: ctx.session?.model,
      cwd: ctx.npc?.cwd,
      pid: ctx.npc?.pid,
      parentId: ctx.npc?.parentId,
      subagentType: ctx.npc?.subagentType,
      includesPrompts: ctx.includePrompts,
      eventCount: ctx.events.length,
      usage: ctx.usage
        ? {
            input: ctx.usage.input,
            output: ctx.usage.output,
            cacheRead: ctx.usage.cacheRead,
            turns: ctx.usage.turns,
          }
        : undefined,
    }),
  );
  const parentId = ctx.npc?.parentId;
  for (const ev of ctx.events) {
    lines.push(JSON.stringify(rowFor(ev, parentId, ctx.includePrompts)));
  }
  return lines.join("\n") + "\n";
}

export function downloadTrace(ctx: ExportContext): void {
  const body = buildTraceJsonl(ctx);
  const blob = new Blob([body], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sessionStub =
    ctx.session?.sessionId?.slice(0, 8) ?? safeFilename(ctx.agentId);
  a.href = url;
  a.download = `agentquest-trace-${safeFilename(ctx.displayName)}-${sessionStub}-${stamp}.jsonl`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}
