"use client";

// LiveThread — renders the running agent's live event stream inside the
// DialogBox when the NPC is linked to an embedded terminal (synced mode).
//
// The transcript watcher on the Electron main side mirrors every claude
// turn into `useAgentStore.eventsByAgent[agentId]`, a ring-buffered per-
// agent log. This component subscribes to that slice and renders each
// event with a style that reflects its semantic type (tool_use, tool
// result, thinking, speech).
//
// Scroll behavior: sticks to the bottom unless the user scrolls up — the
// classic "chat log" feel. The store already caps the log at 100 entries
// per agent, so we don't trim aggressively here.

import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentStore } from "../stores/useAgentStore";
import { buildToolMessage } from "./tool-format";
import type { AgentEvent } from "../events/types";

// A run of N consecutive tool-call events for the same tool, collapsed
// into one row that can expand inline. Plain events are wrapped in a
// `single` form to keep the render loop uniform.
type ThreadItem =
  | { kind: "single"; event: AgentEvent; key: string }
  | {
      kind: "group";
      toolName: string;
      events: AgentEvent[];
      key: string;
    };

function groupConsecutiveToolCalls(events: AgentEvent[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const meta = (e.metadata ?? {}) as { toolName?: string };
    const isToolCall =
      e.type === "agent.state.changed" && typeof meta.toolName === "string";
    if (!isToolCall) {
      items.push({ kind: "single", event: e, key: `${e.timestamp}-${i}` });
      continue;
    }
    const toolName = meta.toolName as string;
    // Extend the previous group if it's the same tool back-to-back.
    const last = items[items.length - 1];
    if (
      last &&
      last.kind === "group" &&
      last.toolName === toolName
    ) {
      last.events.push(e);
      continue;
    }
    items.push({
      kind: "group",
      toolName,
      events: [e],
      key: `${e.timestamp}-${i}`,
    });
  }
  return items;
}

interface LiveThreadProps {
  agentId: string;
  agentName: string;
  onSessionDead?: boolean;
}

// Keep display list modest — store caps at 100; we surface the most recent
// MAX_EVENTS so the DOM stays light even after long sessions.
const MAX_EVENTS = 50;

export default function LiveThread({
  agentId,
  agentName,
  onSessionDead,
}: LiveThreadProps) {
  const events = useAgentStore((s) => s.eventsByAgent[agentId] ?? []);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Start sticky-to-bottom; a user scroll-up flips it false until they
  // come back within 50px of the bottom.
  const stickyRef = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickyRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickyRef.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const visible = events.slice(-MAX_EVENTS);
  const items = useMemo(() => groupConsecutiveToolCalls(visible), [visible]);

  return (
    <div className="min-h-[220px] max-h-[46vh] flex flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="pixel-scroll flex-1 overflow-y-auto pr-1 space-y-1.5"
      >
        {items.length === 0 ? (
          <div className="py-6 text-center italic text-ink-soft text-[13px]">
            Waiting for the agent&apos;s first action…
          </div>
        ) : (
          items.map((item) =>
            item.kind === "single" ? (
              <EventRow
                key={item.key}
                event={item.event}
                agentName={agentName}
              />
            ) : item.events.length === 1 ? (
              <EventRow
                key={item.key}
                event={item.events[0]}
                agentName={agentName}
              />
            ) : (
              <ToolGroupRow
                key={item.key}
                toolName={item.toolName}
                events={item.events}
              />
            ),
          )
        )}
      </div>
      {onSessionDead && (
        <div
          className="mt-2 px-3 py-2 rounded border-2 text-[12px] pixel-font tracking-wide"
          style={{
            borderColor: "#ef4444",
            color: "#ef4444",
            background: "rgba(239, 68, 68, 0.08)",
          }}
        >
          SESSION ENDED · Close this dialog or start another terminal.
        </div>
      )}
    </div>
  );
}

function EventRow({
  event,
  agentName,
}: {
  event: AgentEvent;
  agentName: string;
}) {
  const meta = (event.metadata ?? {}) as {
    toolName?: string;
    isError?: boolean;
    resultText?: string;
    text?: string;
  };

  // 1) Tool calls — agent.state.changed that carries a toolName.
  if (event.type === "agent.state.changed" && meta.toolName) {
    const msg = buildToolMessage(meta.toolName, event.metadata);
    return (
      <div className="text-[12px] text-ink-soft leading-snug">
        <span className="mr-1">⚙</span>
        <span className="font-mono">{msg}</span>
      </div>
    );
  }

  // 2) Tool results — success or error.
  if (event.type === "agent.tool.result") {
    const isError = !!meta.isError;
    const body = (meta.resultText ?? event.message ?? "").slice(0, 160);
    const color = isError ? "#ef4444" : "#6ee7b7";
    const marker = isError ? "✗" : "✓";
    return (
      <div
        className="text-[12px] leading-snug border-l-2 pl-2"
        style={{ borderColor: color }}
      >
        <span
          className="pixel-font text-[10px] mr-1.5 tracking-wide"
          style={{ color }}
        >
          {marker} {isError ? "ERROR" : "OK"}
        </span>
        <span className="font-mono text-ink">{body}</span>
      </div>
    );
  }

  // 3) Thinking excerpts — italic muted.
  if (event.type === "agent.thinking") {
    const text = meta.text ?? event.message;
    return (
      <div className="text-[12px] italic text-ink-soft leading-snug">
        <span className="mr-1">💭</span>
        {text}
      </div>
    );
  }

  // 4) Speech — state.changed "summarizing" without a toolName is the
  //    heuristic the transcript watcher uses to flag a plain-text turn.
  if (
    event.type === "agent.state.changed" &&
    event.state === "summarizing" &&
    !meta.toolName
  ) {
    return (
      <div className="text-[13px] leading-[1.55] text-ink">
        <span className="pixel-font text-[10px] text-accent mr-1.5 tracking-wide">
          ◆ {agentName.toUpperCase()}
        </span>
        {event.message}
      </div>
    );
  }

  // 5) New session divider — small chip.
  if (event.type === "agent.session") {
    return (
      <div className="my-1 flex items-center gap-2">
        <div
          className="flex-1 h-px"
          style={{ background: "var(--border)" }}
        />
        <span className="pixel-font text-[9px] text-ink-soft tracking-wide">
          — NEW SESSION —
        </span>
        <div
          className="flex-1 h-px"
          style={{ background: "var(--border)" }}
        />
      </div>
    );
  }

  // Fallback — any other event type, render the message in muted text so
  // nothing is silently dropped on the floor.
  return (
    <div className="text-[12px] text-ink-soft leading-snug">
      {event.message}
    </div>
  );
}

function ToolGroupRow({
  toolName,
  events,
}: {
  toolName: string;
  events: AgentEvent[];
}) {
  const [expanded, setExpanded] = useState(false);
  const last = events[events.length - 1];
  const lastSummary = buildToolMessage(toolName, last.metadata);
  return (
    <div className="text-[12px] leading-snug">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-baseline gap-1.5 text-left w-full hover:text-ink"
      >
        <span className="text-ink-soft">⚙</span>
        <span className="font-mono text-ink">{toolName}</span>
        <span
          className="pixel-font text-[10px] tracking-wide text-accent"
          aria-label={`${events.length} calls`}
        >
          ×{events.length}
        </span>
        <span className="font-mono text-ink-soft truncate">
          — last: {lastSummary}
        </span>
        <span className="ml-auto text-ink-soft text-[10px] pixel-font">
          {expanded ? "▴" : "▾"}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 ml-4 space-y-0.5 border-l-2 border-ink-soft/30 pl-2">
          {events.map((e, i) => (
            <div
              key={`${e.timestamp}-${i}`}
              className="text-[11px] text-ink-soft leading-snug font-mono"
            >
              {buildToolMessage(toolName, e.metadata)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
