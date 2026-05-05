// Agent behavior registry — declarative table that maps any incoming
// AgentEvent to a visual reaction (which room to walk to, which choreography
// to play, what text to show in the overhead bubble, what emoji to float).
//
// This is the ONE place where "what tool does what in the world" is defined.
// To add a new behavior — say, the agent uses a new `DockerRun` tool and we
// want it to walk to the Forge with a gear animation — append one entry to
// the BEHAVIORS array below. No other file changes needed.
//
// Each entry:
//   id       — unique key for the behavior; also used in logs & debug panels.
//   label    — short description, surfaced in roster "activity" line.
//   room     — destination RoomId (from src/events/types.ts).
//   choreo   — animation key from src/game/choreo.ts.
//   matches  — predicate over an AgentEvent; first true wins.
//   describe — builds the player-facing one-liner (bubble + roster text).
//   priority — optional — higher wins on tie. Default 0. Use for overlapping
//              matchers (e.g. a catch-all "any tool" fallback with priority -1).

import type { AgentEvent, RoomId } from "../events/types";
import type { ChoreoKind } from "./choreo";

export interface AgentBehavior {
  id: string;
  label: string;
  room: RoomId;
  choreo: ChoreoKind;
  matches: (event: AgentEvent) => boolean;
  describe: (event: AgentEvent) => string;
  priority?: number;
}

// Helper to pull a string field out of event.metadata or event.metadata.input.
function getStr(
  event: AgentEvent,
  key: string,
  path: "metadata" | "input" = "metadata",
): string | undefined {
  const src =
    path === "metadata"
      ? event.metadata
      : (event.metadata as { input?: Record<string, unknown> } | undefined)?.input;
  if (!src || typeof src !== "object") return undefined;
  const v = (src as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function toolName(event: AgentEvent): string | undefined {
  return getStr(event, "toolName");
}

// Truncate a path to "{parent}/{file}" for display.
function shortPath(p: string | undefined): string {
  if (!p) return "";
  const clean = p.replace(/^\/+/, "");
  const parts = clean.split("/");
  if (parts.length <= 2) return clean;
  return parts.slice(-2).join("/");
}

// --------------------------------------------------------------------------
// The registry. ORDER MATTERS when priorities tie — first match wins.
// --------------------------------------------------------------------------

export const BEHAVIORS: AgentBehavior[] = [
  // ─── File reading ──────────────────────────────────────────────────────
  {
    id: "read-file",
    label: "Reading a file",
    room: "library",
    choreo: "reading",
    matches: (e) => toolName(e) === "Read",
    describe: (e) => {
      const fp = getStr(e, "file_path", "input");
      return fp ? `Reading ${shortPath(fp)}` : "Reading a file";
    },
  },

  // ─── File writing / editing ───────────────────────────────────────────
  {
    id: "edit-file",
    label: "Editing a file",
    room: "coding_room",
    choreo: "typing",
    matches: (e) => {
      const t = toolName(e);
      return (
        t === "Edit" ||
        t === "Write" ||
        t === "MultiEdit" ||
        t === "NotebookEdit"
      );
    },
    describe: (e) => {
      const fp =
        getStr(e, "file_path", "input") ??
        getStr(e, "notebook_path", "input");
      if (!fp) return "Editing a file";
      const t = toolName(e);
      const verb = t === "Write" ? "Writing" : "Editing";
      return `${verb} ${shortPath(fp)}`;
    },
  },

  // ─── Bash / terminal ──────────────────────────────────────────────────
  {
    id: "bash",
    label: "Running a command",
    room: "tool_workshop",
    choreo: "hammering",
    matches: (e) => toolName(e) === "Bash",
    describe: (e) => {
      const cmd = getStr(e, "command", "input") ?? "";
      return cmd ? `Running: ${cmd.slice(0, 40)}` : "Running a command";
    },
  },

  // ─── Code search (Grep / Glob) ─────────────────────────────────────────
  {
    id: "search-code",
    label: "Searching code",
    room: "library",
    choreo: "searching",
    matches: (e) => {
      const t = toolName(e);
      return t === "Grep" || t === "Glob";
    },
    describe: (e) => {
      const pat = getStr(e, "pattern", "input");
      if (pat) return `Searching: ${pat.slice(0, 40)}`;
      return "Searching code";
    },
  },

  // ─── Web search / fetch ───────────────────────────────────────────────
  {
    id: "search-web",
    label: "Browsing the web",
    room: "tool_workshop",
    choreo: "browsing",
    matches: (e) => {
      const t = toolName(e);
      return t === "WebFetch" || t === "WebSearch";
    },
    describe: (e) => {
      const url = getStr(e, "url", "input");
      const q = getStr(e, "query", "input");
      if (url) return `Fetching ${url.slice(0, 40)}`;
      if (q) return `Searching the web: ${q.slice(0, 40)}`;
      return "Browsing the web";
    },
  },

  // ─── Task / sub-agent spawn ────────────────────────────────────────────
  {
    id: "task",
    label: "Delegating to sub-agent",
    room: "desk",
    choreo: "directing",
    matches: (e) => toolName(e) === "Task",
    describe: (e) => {
      const desc =
        getStr(e, "description", "input") ??
        getStr(e, "subagent_type", "input");
      return desc ? `Task: ${desc.slice(0, 40)}` : "Launching sub-agent";
    },
  },

  // ─── TodoWrite / planning ─────────────────────────────────────────────
  {
    id: "planning",
    label: "Updating the plan",
    room: "desk",
    choreo: "planning",
    matches: (e) => toolName(e) === "TodoWrite",
    describe: () => "Updating the plan",
  },

  // ─── Task result (synthetic — fired by the bridge on tool_result) ──────
  // Tells the scene to end the "directing" choreo and return to idle.
  // This is intentionally lower priority than "task" so ordering matters
  // when both could match a weird edge case.
  {
    id: "task-result",
    label: "Sub-agent finished",
    room: "desk",
    choreo: "idle-bob",
    matches: (e) =>
      toolName(e) === "TaskResult" ||
      Boolean((e.metadata as { taskCompleted?: boolean })?.taskCompleted),
    describe: () => "Sub-agent finished",
    priority: 10,
  },

  // ─── Extended reasoning / <thinking> blocks ───────────────────────────
  // Thinking usually happens BEFORE a tool call (the agent reasons, then
  // invokes a tool). We treat it as a passive pose so the store reuses
  // the prior room/choreo (see useAgentStore.pushEvent isPassive branch)
  // — the thinking bubble still updates the roster and activity log, but
  // the NPC stays in whichever room the last tool sent it to. On the very
  // first turn (no prior activity) this falls through to fallback → desk,
  // which is the right default.
  {
    id: "thinking",
    label: "Thinking deeply",
    room: "desk",
    choreo: "pondering",
    matches: (e) => e.type === "agent.thinking",
    describe: (e) => {
      const text =
        (e.metadata as { text?: string } | undefined)?.text ?? e.message ?? "";
      return text ? text.slice(0, 60) : "Thinking…";
    },
    priority: -1,
  },

  // ─── Tool failure reaction ─────────────────────────────────────────────
  // When a tool_result comes back with an error, stay at the tool's last
  // room (the provider doesn't reset room) but play a brief "confused"
  // pose so the player notices something went wrong.
  {
    id: "tool-error",
    label: "Hit an error",
    room: "desk",
    choreo: "pondering",
    matches: (e) =>
      e.type === "agent.tool.result" &&
      Boolean((e.metadata as { isError?: boolean } | undefined)?.isError),
    describe: (e) => e.message?.slice(0, 60) || "Tool errored",
    priority: 6,
  },

  // ─── Brainstorm / text message ─────────────────────────────────────────
  // Fires when the agent emits a text block (thinking out loud) and there's
  // no tool in flight. Sends it to the desk for a "pondering" pose.
  {
    id: "brainstorm",
    label: "Thinking",
    room: "desk",
    choreo: "pondering",
    matches: (e) =>
      e.state === "summarizing" &&
      !toolName(e) &&
      !(e.metadata as { taskCompleted?: boolean })?.taskCompleted,
    describe: (e) => e.message?.slice(0, 60) || "Thinking",
  },

  // ─── Catch-all fallback ────────────────────────────────────────────────
  // Any event that didn't match above still routes to the desk with an
  // idle-bob. Negative priority so real matchers always win.
  {
    id: "fallback",
    label: "Working",
    room: "desk",
    choreo: "idle-bob",
    matches: () => true,
    describe: (e) => e.message?.slice(0, 60) || "Working",
    priority: -100,
  },
];

// --------------------------------------------------------------------------
// Runtime lookup.
// --------------------------------------------------------------------------

/**
 * Resolve the best-matching behavior for an AgentEvent. Always returns a
 * behavior — the last entry in BEHAVIORS is a catch-all.
 */
export function matchBehavior(event: AgentEvent): AgentBehavior {
  let best: AgentBehavior | null = null;
  let bestPrio = -Infinity;
  for (const b of BEHAVIORS) {
    if (!b.matches(event)) continue;
    const prio = b.priority ?? 0;
    if (prio > bestPrio) {
      best = b;
      bestPrio = prio;
    }
  }
  // Safe cast: the fallback guarantees best is non-null.
  return best!;
}

/**
 * Direct lookup by id — handy for test harnesses, demo beats, or debug UI.
 */
export function behaviorById(id: string): AgentBehavior | undefined {
  return BEHAVIORS.find((b) => b.id === id);
}
