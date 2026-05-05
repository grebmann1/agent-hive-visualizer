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
  | "agent.session";

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
  | "cinema"
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
