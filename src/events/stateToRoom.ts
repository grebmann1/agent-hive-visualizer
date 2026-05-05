import type { AgentState, RoomId } from "./types";

export const stateToRoom: Record<AgentState, RoomId> = {
  // Idle / waiting states send the NPC to the Lounge to chill.
  idle: "cinema",
  waiting_for_user: "cinema",
  completed: "cinema",
  thinking: "desk",
  planning: "desk",
  coding: "coding_room",
  reading_file: "library",
  searching: "library",
  calling_tool: "tool_workshop",
  // Task tool → sub-agent spawn. Route the parent to the Meeting Room so
  // the visual reads as "delegating to a helper".
  talking_to_agent: "meeting_room",
  running_tests: "testing_lab",
  debugging: "coding_room",
  deploying: "tool_workshop",
  summarizing: "desk",
  failed: "desk",
};

export const stateToFace: Record<AgentState, string> = {
  idle: "🙂",
  waiting_for_user: "🙂",
  thinking: "🤔",
  planning: "🧠",
  coding: "⌨️",
  reading_file: "📖",
  searching: "🔎",
  calling_tool: "🔧",
  talking_to_agent: "💬",
  running_tests: "🧪",
  debugging: "🐛",
  deploying: "🚀",
  summarizing: "📝",
  completed: "🎉",
  failed: "😵",
};

// Compact emoji that the always-on overhead pill shows for the agent's
// current tool. Indexed by hook `tool_name`. Unknown tools fall back to
// the state-derived emoji via `stateToFace`; idle agents show 💭.
export const TOOL_EMOJI: Record<string, string> = {
  Read: "📖",
  Edit: "✏️",
  Write: "✏️",
  MultiEdit: "✏️",
  NotebookEdit: "✏️",
  Bash: "🖥️",
  Grep: "🔎",
  Glob: "🔎",
  WebFetch: "🌐",
  WebSearch: "🌐",
  Task: "🤝",
  TodoWrite: "📝",
};

export const IDLE_EMOJI = "💭";
export const ERROR_EMOJI = "❌";
export const COMPLETED_EMOJI = "✅";

/** Resolve the emoji for an activity's current state. Prefers the tool
 *  name (coming from event.metadata.toolName) over the state lookup. */
export function emojiForActivity(
  toolName: string | undefined,
  state: AgentState | undefined,
): string {
  if (toolName && TOOL_EMOJI[toolName]) return TOOL_EMOJI[toolName];
  if (state && stateToFace[state]) return stateToFace[state];
  return IDLE_EMOJI;
}
