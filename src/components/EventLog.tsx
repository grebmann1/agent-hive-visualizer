"use client";

// EventLog — small collapsible panel listing the most recent AgentEvents.
// Useful for verifying that a new provider or behavior is wired correctly
// without opening devtools. Toggled with `L` key (handled below).

import { useEffect, useState } from "react";
import { useAgentStore } from "../stores/useAgentStore";
import { matchBehavior } from "../game/behaviors";

const MAX_ROWS = 20;

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toTimeString().slice(0, 8);
  } catch {
    return iso;
  }
}

export default function EventLog() {
  const events = useAgentStore((s) => s.events);
  const [open, setOpen] = useState(false);

  // `L` toggles the panel (but only when focus is outside an input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA") return;
      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tail = events.slice(-MAX_ROWS).reverse();

  return (
    <div className="panel text-[11px] flex flex-col" style={{ minHeight: 0 }}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="pixel-font text-[10px] tracking-wide">▸ EVENT LOG</h3>
        <button
          onClick={() => setOpen((v) => !v)}
          className="pixel-font text-[8px] text-ink-soft hover:text-ink underline"
          title="Toggle with L"
        >
          {open ? "[HIDE]" : "[SHOW]"}
        </button>
      </div>
      {open && (
        <>
          {tail.length === 0 ? (
            <p className="text-[10px] opacity-60 italic">
              No events yet. Run a `claude` command in any terminal.
            </p>
          ) : (
            <ul
              className="overflow-y-auto pixel-scroll text-[10px] font-mono leading-snug"
              style={{ maxHeight: 200 }}
            >
              {tail.map((e, i) => {
                const b = matchBehavior(e);
                const t = formatTime(e.timestamp);
                return (
                  <li
                    key={`${e.timestamp}-${i}`}
                    className="flex items-baseline gap-2 py-0.5 border-t border-paper-dim first:border-t-0"
                  >
                    <span className="opacity-50 shrink-0">{t}</span>
                    <span
                      className="pixel-font text-[8px] shrink-0 px-1 py-0.5 rounded"
                      style={{ background: "#e4dcc4", color: "#1b1e2b" }}
                    >
                      {b.id}
                    </span>
                    <span className="opacity-75 shrink-0">{e.agentId.slice(0, 16)}</span>
                    <span className="truncate min-w-0">{e.message || "—"}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-[8px] opacity-50 mt-2">
            press <kbd className="pixel-font text-[8px] px-1 bg-paper-dim border border-ink rounded">L</kbd> to toggle
          </p>
        </>
      )}
    </div>
  );
}
