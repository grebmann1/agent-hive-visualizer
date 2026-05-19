"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentStore } from "../stores/useAgentStore";
import { useNpcStore } from "../stores/useNpcStore";

// Persistent "is the pipeline live?" indicator for the top of the game
// panel. Reads purely from existing stores:
//   - useAgentStore.events       — global event log (new events push append)
//   - useAgentStore.eventsByAgent — per-agent log (for stage heuristics)
//   - useNpcStore.dynamic        — currently-observed claudes
//
// The chip surfaces three numbers (agents / ev-per-5s / last-event-age) and a
// colored dot that goes amber or red as the pipeline goes quiet. Hovering
// expands a detail popover with per-stage dots + last-3-events.

const STALE_AMBER_MS = 30_000; //  30s silence → amber
const STALE_RED_MS = 120_000; // 120s silence → red
const WINDOW_MS = 5_000; // rolling rate window

function formatAge(ms: number | null): string {
  if (ms === null) return "never";
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

interface HookStatus {
  installed: boolean;
  bound: boolean;
  bindError: string | null;
}

export default function LiveStatusChip() {
  const events = useAgentStore((s) => s.events);
  const dynamic = useNpcStore((s) => s.dynamic);

  // tick so derived age strings re-render without needing a store write.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll hook-server status every 5s so the chip distinguishes "no
  // agents running" (idle) from "AgentQuest can't open its hook port"
  // (broken). Without this, both render as red+0 agents.
  const [hookStatus, setHookStatus] = useState<HookStatus | null>(null);
  useEffect(() => {
    const bridge =
      typeof window !== "undefined" ? window.agentquest : undefined;
    if (!bridge?.hooks?.status) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await bridge.hooks!.status!();
        if (!cancelled) {
          setHookStatus({
            installed: s.installed,
            bound: s.bound,
            bindError: s.bindError,
          });
        }
      } catch {
        // ignore — status is advisory
      }
    };
    poll();
    const t = setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Rolling 5s event count — count events whose timestamp is within WINDOW_MS
  // of `now`. Cheap: events array is already capped, and we only read the
  // tail of it.
  const eventsIn5s = useMemo(() => {
    let n = 0;
    const cutoff = now - WINDOW_MS;
    // iterate backwards since recent events are at the end
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const t = Date.parse(e.timestamp);
      if (!Number.isFinite(t)) continue;
      if (t < cutoff) break;
      n++;
    }
    return n;
  }, [events, now]);

  const agentCount = Object.keys(dynamic).length;

  const lastEventAgeMs = useMemo(() => {
    const last = events[events.length - 1];
    if (!last) return null;
    const t = Date.parse(last.timestamp);
    if (!Number.isFinite(t)) return null;
    return now - t;
  }, [events, now]);

  // Dot color. Hook-server bind failure dominates everything else —
  // no point reporting "stale" if the receiver isn't even listening.
  const hookBroken = hookStatus
    ? hookStatus.installed && !hookStatus.bound
    : false;
  let dot: "green" | "amber" | "red" = "red";
  if (hookBroken) {
    dot = "red";
  } else if (agentCount === 0 || lastEventAgeMs === null) {
    dot = "red";
  } else if (lastEventAgeMs < STALE_AMBER_MS) {
    dot = "green";
  } else if (lastEventAgeMs < STALE_RED_MS) {
    dot = "amber";
  } else {
    dot = "red";
  }

  const dotColor =
    dot === "green" ? "#6ee7b7" : dot === "amber" ? "#fbbf24" : "#ef4444";

  // Hover popover
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div
        className="hud-chip pixel-font text-[9px] flex items-center gap-2"
        style={{ cursor: "default" }}
      >
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: dotColor,
            boxShadow: `0 0 6px ${dotColor}`,
          }}
        />
        {hookBroken ? (
          <span
            className="tracking-wide"
            style={{ color: "#ef4444" }}
            title={hookStatus?.bindError ?? undefined}
          >
            ! HOOK SERVER
          </span>
        ) : (
          <>
            <span className="tracking-wide">
              {agentCount} AGENT{agentCount === 1 ? "" : "S"}
            </span>
            <span className="opacity-60">·</span>
            <span className="tabular-nums">{eventsIn5s} EV/5S</span>
            <span className="opacity-60">·</span>
            <span className="tabular-nums">
              {formatAge(lastEventAgeMs)} AGO
            </span>
          </>
        )}
      </div>
      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full mt-2 z-40 panel pixel-font text-[10px] min-w-[260px]"
          style={{ padding: 10 }}
        >
          <PipelineDetail now={now} hookStatus={hookStatus} />
        </div>
      )}
    </div>
  );
}

function PipelineDetail({
  now,
  hookStatus,
}: {
  now: number;
  hookStatus: HookStatus | null;
}) {
  const events = useAgentStore((s) => s.events);
  const dynamic = useNpcStore((s) => s.dynamic);

  // Per-stage heuristics: recent activity = pipeline OK.
  const FIVE_MIN = 5 * 60_000;
  const recentlyActiveEvents = events.filter(
    (e) => now - Date.parse(e.timestamp) < FIVE_MIN,
  );
  const hasDetectedAgent = Object.keys(dynamic).length > 0;
  const hasToolOrResult = recentlyActiveEvents.some(
    (e) =>
      e.type === "agent.tool.result" ||
      (e.type === "agent.state.changed" &&
        (e.metadata as { toolName?: string } | undefined)?.toolName),
  );
  const hasAnyEvent = recentlyActiveEvents.length > 0;
  const serverOk = hookStatus ? hookStatus.installed && hookStatus.bound : true;

  const stages: Array<{ name: string; ok: boolean; note: string }> = [
    {
      name: "Server",
      ok: serverOk,
      note: !hookStatus
        ? "status unavailable"
        : !hookStatus.installed
          ? "wrapper not installed"
          : !hookStatus.bound
            ? hookStatus.bindError ?? "port unavailable"
            : "loopback receiver bound",
    },
    {
      name: "Hooks",
      ok: hasDetectedAgent,
      note: hasDetectedAgent
        ? `${Object.keys(dynamic).length} claude session(s) live`
        : "no hook events yet",
    },
    {
      name: "Tools",
      ok: hasToolOrResult,
      note: hasToolOrResult
        ? "tool_use / tool_result flowing"
        : "no tool events in last 5 min",
    },
    {
      name: "Provider → Store",
      ok: hasAnyEvent,
      note: hasAnyEvent
        ? `${recentlyActiveEvents.length} events in last 5 min`
        : "no events at all",
    },
  ];

  const tail = events.slice(-3).reverse();

  const copyJson = () => {
    const payload = JSON.stringify(events.slice(-20), null, 2);
    try {
      void navigator.clipboard.writeText(payload);
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        {stages.map((s) => (
          <div
            key={s.name}
            className="flex items-center gap-2 tracking-wide"
          >
            <span
              style={{
                display: "inline-block",
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: s.ok ? "#6ee7b7" : "#ef4444",
              }}
            />
            <span className="font-semibold">{s.name.toUpperCase()}</span>
            <span className="opacity-70">— {s.note}</span>
          </div>
        ))}
      </div>
      <div className="border-t-2 border-ink pt-2">
        <div className="opacity-60 tracking-wide mb-1">LAST 3 EVENTS</div>
        {tail.length === 0 && (
          <div className="opacity-50">(none yet)</div>
        )}
        {tail.map((e, i) => (
          <div key={`${e.timestamp}-${i}`} className="opacity-90">
            {formatAge(now - Date.parse(e.timestamp))} ago · {e.agentId} ·{" "}
            {e.state ?? e.type.replace(/^agent\./, "")}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={copyJson}
        className="pixel-font text-[9px] px-2 py-1 rounded border-2 border-ink bg-paper hover:bg-paper-dim tracking-wide self-start"
      >
        COPY LAST 20 EVENTS
      </button>
    </div>
  );
}
