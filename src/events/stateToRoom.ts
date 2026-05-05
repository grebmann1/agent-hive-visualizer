import type { AgentState, RoomId } from "./types";

export const stateToRoom: Record<AgentState, RoomId> = {
  // Idle / waiting states send the NPC to the Cinema to chill.
  idle: "cinema",
  waiting_for_user: "cinema",
  completed: "cinema",
  thinking: "desk",
  planning: "desk",
  coding: "coding_room",
  reading_file: "library",
  searching: "library",
  calling_tool: "tool_workshop",
  talking_to_agent: "desk",
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
