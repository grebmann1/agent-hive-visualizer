import { create } from "zustand";
import type { AgentEvent, AnimationId, RoomId } from "../events/types";
import { eventToVisualAction } from "../events/visualRules";
import { matchBehavior } from "../game/behaviors";
import type { ChoreoKind } from "../game/choreo";

export interface NpcActivity {
  // which NPC this describes
  agentId: string;
  // human-readable bubble text ("coding...", "running tests...")
  bubble: string;
  // Phaser visual action — room + animation (animation is legacy, prefer choreo)
  room: RoomId;
  animation: AnimationId;
  // Behavior registry outputs — these are the canonical source of truth for
  // "what should this NPC do visually". WorldScene reads these directly.
  behaviorId: string;
  choreo: ChoreoKind;
  // monotonically increasing — scene uses this to detect new activity
  version: number;
  // Pass-through of the full event so consumers can inspect tool metadata
  // (e.g. subagentType for Task events).
  event: AgentEvent;
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  // Turn counter — incremented on each usage delta received. Useful for the
  // Activity modal to show how many assistant turns have happened.
  turns: number;
  lastUpdate: string;
}

export interface AgentSessionInfo {
  model: string | null;
  sessionId: string | null;
  tools: string[];
  startedAt: string;
}

interface AgentStoreState {
  events: AgentEvent[];
  currentRoom: RoomId;
  currentBubble: string;
  currentFace: string;
  currentAnimation: AnimationId;
  currentTask: string;
  lastStateLabel: string;
  bubbleVersion: number;

  // Per-NPC activity — scene subscribes and surfaces it as overhead bubble
  activities: Record<string, NpcActivity>;

  // Per-agent cumulative token usage. Updated from `agent.session` init
  // metadata and `agent.state.changed` events whose metadata carries a
  // `usage` delta. NEVER triggers a behavior match — just a UI-side counter.
  usageByAgent: Record<string, AgentUsage>;

  // Most recent `thinking` excerpt per agent. Short, truncated string.
  thinkingByAgent: Record<string, string>;

  // Session metadata (model, tools, sessionId) per agent, populated from
  // the transcript's `system_init` line.
  sessionByAgent: Record<string, AgentSessionInfo>;

  // Per-agent ring-buffered event log (last N entries). Dialog's LiveThread
  // and ActivityModal subscribe to this slice to avoid re-filtering the
  // global `events` array on every render.
  eventsByAgent: Record<string, AgentEvent[]>;

  pushEvent: (event: AgentEvent) => void;
  // Narrow fast path for cost/usage deltas — doesn't run behavior matcher.
  // `turnCount` defaults to 1 (a single live turn); bootstrap paths can pass
  // the historical turn count so totals aren't visually "1 turn" on attach.
  applyUsageDelta: (
    agentId: string,
    delta: Omit<AgentUsage, "turns" | "lastUpdate">,
    timestamp: string,
    turnCount?: number,
  ) => void;
  applySession: (agentId: string, info: AgentSessionInfo) => void;
  reset: () => void;
}

const initial = {
  events: [] as AgentEvent[],
  currentRoom: "desk" as RoomId,
  currentBubble: "Waiting for a task...",
  currentFace: "🙂",
  currentAnimation: "idle" as AnimationId,
  currentTask: "Idle",
  lastStateLabel: "idle",
  bubbleVersion: 0,
  activities: {} as Record<string, NpcActivity>,
  usageByAgent: {} as Record<string, AgentUsage>,
  thinkingByAgent: {} as Record<string, string>,
  sessionByAgent: {} as Record<string, AgentSessionInfo>,
  eventsByAgent: {} as Record<string, AgentEvent[]>,
};

const EVENTS_PER_AGENT_CAP = 100;

let activityVersion = 0;

export const useAgentStore = create<AgentStoreState>((set) => ({
  ...initial,

  pushEvent: (event) => {
    // Route through the behavior registry (src/game/behaviors.ts) for the
    // room + choreo + bubble — this is the single source of truth for
    // "what does this event mean visually". `eventToVisualAction` is kept
    // around for its legacy face/animation fields only.
    const behavior = matchBehavior(event);
    const bubble = behavior.describe(event) || event.message;
    const action = eventToVisualAction(event);
    activityVersion += 1;

    // Side-channel: if this event carries a `thinking` excerpt in metadata,
    // mirror it into `thinkingByAgent` so the roster + Activity modal can
    // display it without re-scanning the event log.
    const thinkingText =
      event.type === "agent.thinking"
        ? (event.metadata as { text?: string } | undefined)?.text
        : undefined;

    // "Passive" events — tool_result (success), text turn-end, thinking —
    // shouldn't yank the NPC out of the tool's room back to the desk.
    // They update the bubble + log but REUSE the previous room/choreo so
    // the agent keeps its visible pose until the NEXT tool_use.
    //
    // Active events (tool_use) always take effect. Errors (tool-error
    // behavior) also do, since they deliberately change the pose.
    const isPassive =
      event.type === "agent.thinking" ||
      event.type === "agent.session" ||
      (event.type === "agent.tool.result" &&
        !(event.metadata as { isError?: boolean } | undefined)?.isError) ||
      (event.type === "agent.state.changed" &&
        event.state === "summarizing" &&
        !(event.metadata as { toolName?: string } | undefined)?.toolName);

    set((s) => {
      const prev = s.activities[event.agentId];
      const nextRoom = isPassive && prev ? prev.room : behavior.room;
      const nextChoreo = isPassive && prev ? prev.choreo : behavior.choreo;
      const nextBehaviorId = isPassive && prev ? prev.behaviorId : behavior.id;
      const nextAnimation = isPassive && prev ? prev.animation : action.animation;

      // Ring-buffered per-agent log (last EVENTS_PER_AGENT_CAP entries).
      const priorAgentEvents = s.eventsByAgent[event.agentId] ?? [];
      const nextAgentEvents =
        priorAgentEvents.length >= EVENTS_PER_AGENT_CAP
          ? [...priorAgentEvents.slice(1), event]
          : [...priorAgentEvents, event];

      return {
        events: [...s.events, event],
        currentRoom: nextRoom,
        currentBubble: bubble,
        currentFace: action.face,
        currentAnimation: nextAnimation,
        currentTask: event.message,
        lastStateLabel: event.state ?? event.type.replace("agent.", ""),
        bubbleVersion: s.bubbleVersion + 1,
        activities: {
          ...s.activities,
          [event.agentId]: {
            agentId: event.agentId,
            bubble,
            room: nextRoom,
            animation: nextAnimation,
            behaviorId: nextBehaviorId,
            choreo: nextChoreo,
            version: activityVersion,
            event,
          },
        },
        thinkingByAgent: thinkingText
          ? { ...s.thinkingByAgent, [event.agentId]: thinkingText }
          : s.thinkingByAgent,
        eventsByAgent: {
          ...s.eventsByAgent,
          [event.agentId]: nextAgentEvents,
        },
      };
    });
  },

  applyUsageDelta: (agentId, delta, timestamp, turnCount = 1) =>
    set((s) => {
      const prev = s.usageByAgent[agentId];
      const next: AgentUsage = {
        input: (prev?.input ?? 0) + delta.input,
        output: (prev?.output ?? 0) + delta.output,
        cacheCreate: (prev?.cacheCreate ?? 0) + delta.cacheCreate,
        cacheRead: (prev?.cacheRead ?? 0) + delta.cacheRead,
        turns: (prev?.turns ?? 0) + turnCount,
        lastUpdate: timestamp,
      };
      return { usageByAgent: { ...s.usageByAgent, [agentId]: next } };
    }),

  applySession: (agentId, info) =>
    set((s) => ({
      sessionByAgent: { ...s.sessionByAgent, [agentId]: info },
    })),

  reset: () => set({ ...initial }),
}));
