export type AgentState =
  | "idle"
  | "waiting_for_user"
  | "thinking"
  | "planning"
  | "coding"
  | "reading_file"
  | "searching"
  | "calling_tool"
  | "talking_to_agent"
  | "running_tests"
  | "debugging"
  | "deploying"
  | "summarizing"
  | "completed"
  | "failed";

export type AgentEventType =
  | "agent.state.changed"
  | "agent.tool.called"
  | "agent.tool.result"
  | "agent.file.edited"
  | "agent.error"
  | "agent.completed"
  | "agent.waiting_for_user"
  | "agent.thinking"
  | "agent.session"
  // Emitted on the PARENT agent's stream when a Task-spawned helper
  // finishes (SubagentStop). metadata: { childAgentId: string,
  // summary?: string, isError?: boolean }
  | "agent.subagent.completed";

export interface AgentEvent {
  type: AgentEventType;
  agentId: string;
  state?: AgentState;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export type RoomId =
  | "desk"
  | "coding_room"
  | "library"
  | "tool_workshop"
  | "testing_lab"
  | "meeting_room";

export type AnimationId =
  | "idle"
  | "walk"
  | "typing"
  | "use_machine"
  | "searching"
  | "testing"
  | "confused"
  | "celebrate";

export interface VisualAction {
  room: RoomId;
  animation: AnimationId;
  bubble: string;
  face: string;
}

/** Extract the in-flight tool name from an event's metadata, with a
 *  typed cast so callers don't have to repeat the same `as` dance. */
export function eventToolName(event: AgentEvent): string | undefined {
  const v = (event.metadata as { toolName?: unknown } | undefined)?.toolName;
  return typeof v === "string" ? v : undefined;
}
