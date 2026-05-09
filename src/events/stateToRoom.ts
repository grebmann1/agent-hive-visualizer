import type { AgentState, RoomId } from "./types";

export const stateToRoom: Record<AgentState, RoomId> = {
  // Idle / waiting states park the NPC at a desk seat.
  idle: "desk",
  waiting_for_user: "desk",
  completed: "desk",
  thinking: "desk",
  planning: "desk",
  // Coding happens at the agent's own desk — the visual we want is
  // "agent sits down and types" rather than "agent walks to a code lab".
  coding: "desk",
  reading_file: "library",
  searching: "library",
  calling_tool: "tool_workshop",
  // Task tool → sub-agent spawn. Route the parent to the Meeting Room so
  // the visual reads as "delegating to a helper".
  talking_to_agent: "meeting_room",
  running_tests: "testing_lab",
  // Debugging is also a desk activity — same screen, different mood.
  debugging: "desk",
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
// Transient "user just spoke" indicator — flashed by the overhead
// pill when a UserPromptSubmit hook arrives.
export const PROMPT_EMOJI = "📨";

// Human-readable label for an AgentState. Used wherever the raw state
// id (e.g. "calling_tool") would otherwise leak into UI copy.
export const stateToLabel: Record<AgentState, string> = {
  idle: "Idle",
  waiting_for_user: "Awaiting input",
  thinking: "Thinking",
  planning: "Planning",
  coding: "Coding",
  reading_file: "Reading",
  searching: "Searching",
  calling_tool: "Using tool",
  talking_to_agent: "Delegating",
  running_tests: "Testing",
  debugging: "Debugging",
  deploying: "Deploying",
  summarizing: "Summarizing",
  completed: "Completed",
  failed: "Failed",
};

// Human-readable label for a hook tool name. Same role as TOOL_EMOJI:
// preferred over the state-derived label when a tool is in flight.
export const TOOL_LABEL: Record<string, string> = {
  Read: "Reading",
  Edit: "Editing",
  Write: "Writing",
  MultiEdit: "Editing",
  NotebookEdit: "Editing",
  Bash: "Running command",
  Grep: "Searching",
  Glob: "Globbing",
  WebFetch: "Fetching",
  WebSearch: "Searching web",
  Task: "Delegating",
  TodoWrite: "Planning",
};

export function formatState(s: AgentState | undefined): string {
  if (!s) return "";
  return stateToLabel[s] ?? s;
}

export function formatTool(t: string | undefined): string {
  if (!t) return "";
  return TOOL_LABEL[t] ?? t;
}

/** Resolve the human-readable label for an activity. Mirrors
 *  emojiForActivity — prefers the in-flight tool over the state. */
export function labelForActivity(
  toolName: string | undefined,
  state: AgentState | undefined,
): string {
  if (toolName && TOOL_LABEL[toolName]) return TOOL_LABEL[toolName];
  if (state && stateToLabel[state]) return stateToLabel[state];
  return "";
}

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
