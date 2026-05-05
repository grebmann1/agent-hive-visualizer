import type { AgentEvent, VisualAction } from "./types";
import { stateToFace, stateToRoom } from "./stateToRoom";

export function eventToVisualAction(event: AgentEvent): VisualAction {
  switch (event.type) {
    case "agent.file.edited": {
      const file = (event.metadata?.file as string) ?? "a file";
      return {
        room: "coding_room",
        animation: "typing",
        bubble: `Editing ${file}`,
        face: "⌨️",
      };
    }

    case "agent.tool.called": {
      const tool = (event.metadata?.toolName as string) ?? "a tool";
      return {
        room: "tool_workshop",
        animation: "use_machine",
        bubble: `Using ${tool}`,
        face: "🔧",
      };
    }

    case "agent.tool.result": {
      return {
        room: "tool_workshop",
        animation: "idle",
        bubble: event.message || "Got a result!",
        face: "🙂",
      };
    }

    case "agent.error": {
      return {
        room: "coding_room",
        animation: "confused",
        bubble: event.message || "Oops, something went wrong!",
        face: "😵",
      };
    }

    case "agent.completed": {
      return {
        room: "desk",
        animation: "celebrate",
        bubble: event.message || "All done!",
        face: "🎉",
      };
    }

    case "agent.waiting_for_user": {
      return {
        room: "desk",
        animation: "idle",
        bubble: event.message || "Waiting for you...",
        face: "🙂",
      };
    }

    case "agent.state.changed": {
      const state = event.state ?? "idle";
      return {
        room: stateToRoom[state],
        animation:
          state === "coding"
            ? "typing"
            : state === "searching" || state === "reading_file"
              ? "searching"
              : state === "running_tests"
                ? "testing"
                : state === "calling_tool"
                  ? "use_machine"
                  : state === "failed"
                    ? "confused"
                    : state === "completed"
                      ? "celebrate"
                      : "idle",
        bubble: event.message,
        face: stateToFace[state],
      };
    }

    // `thinking` and `session` are side-channel transcript signals. They
    // don't have a meaningful face/animation mapping — the behavior
    // registry handles routing; this legacy shim just returns a sensible
    // neutral state so callers that still read from VisualAction compile.
    case "agent.thinking": {
      return {
        room: "desk",
        animation: "idle",
        bubble: event.message || "Thinking…",
        face: "🤔",
      };
    }

    case "agent.session": {
      return {
        room: "desk",
        animation: "idle",
        bubble: event.message || "Session started",
        face: "🙂",
      };
    }
  }
}
