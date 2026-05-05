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

import { useEffect, useRef } from "react";
import { useAgentStore } from "../stores/useAgentStore";
import { buildToolMessage } from "./tool-format";
import type { AgentEvent } from "../events/types";

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

  return (
    <div className="min-h-[220px] max-h-[46vh] flex flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="pixel-scroll flex-1 overflow-y-auto pr-1 space-y-1.5"
      >
        {visible.length === 0 ? (
          <div className="py-6 text-center italic text-ink-soft text-[13px]">
            Waiting for the agent&apos;s first action…
          </div>
        ) : (
          visible.map((e, i) => (
            <EventRow
              key={`${e.timestamp}-${i}`}
              event={e}
              agentName={agentName}
            />
          ))
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
    const color = isError ? "#ef4444" : "#22c55e";
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
        <span className="pixel-font text-[10px] text-accent-dark mr-1.5 tracking-wide">
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
