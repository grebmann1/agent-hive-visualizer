"use client";

// Debug panel — a small modal exposing logging toggles and the
// agent motion log export. Lives outside the canvas so the user can
// flip recording on, reproduce a bug, then export without leaving
// the app.
//
// Today there's just one toggle (agent motion log). The component is
// shaped to host more toggles later (e.g. a hook-payload tracer)
// without a refactor.

import { useEffect, useState } from "react";
import {
  isEnabled as agentLogEnabled,
  setEnabled as setAgentLogEnabled,
  size as agentLogSize,
  download as agentLogDownload,
  clear as agentLogClear,
} from "../game/agentLog";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function DebugPanel({ open, onClose }: Props) {
  const [logOn, setLogOn] = useState(false);
  const [logCount, setLogCount] = useState(0);

  // Keep the local mirror in sync with the module's state on every
  // open. Also poll the count while the panel is open so the user
  // can watch entries flow in as they reproduce a bug.
  useEffect(() => {
    if (!open) return;
    setLogOn(agentLogEnabled());
    setLogCount(agentLogSize());
    const interval = setInterval(() => {
      setLogCount(agentLogSize());
    }, 250);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(interval);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const toggle = () => {
    const next = !logOn;
    setAgentLogEnabled(next);
    setLogOn(next);
    if (!next) setLogCount(0);
  };

  const onClear = () => {
    agentLogClear();
    setLogCount(0);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="debug-panel-title"
        className="dialog-box w-[min(92vw,440px)]"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "dialogIn 180ms ease" }}
      >
        <div className="flex items-center justify-between mb-3">
          <h3
            id="debug-panel-title"
            className="pixel-font text-[12px] text-accent"
          >
            ◆ DEBUG TOOLS
          </h3>
          <button
            onClick={onClose}
            className="pixel-font text-[10px] text-ink-soft hover:text-ink underline"
            aria-label="Close dialog"
          >
            [CLOSE]
          </button>
        </div>

        <section className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="pixel-font text-[10px] tracking-wide">
              AGENT MOTION LOG
            </span>
            <button
              onClick={toggle}
              className="pixel-font text-[9px] px-2 py-1 rounded border-2 border-ink"
              style={{
                background: logOn ? "#6ee7b7" : "#2a3150",
                color: logOn ? "#141827" : "#8e94bf",
              }}
            >
              {logOn ? "ON" : "OFF"}
            </button>
          </div>
          <p className="text-[12px] leading-relaxed opacity-75 mb-2">
            Records every position write — spawn, walk steps, seat
            snaps, separation pushes, summons. Used to spot teleports
            (large pixel jumps without an intervening walk-step).
          </p>
          <div className="flex items-center gap-2 pixel-font text-[9px] text-ink-soft mb-2">
            <span>Buffer: {logCount.toLocaleString()} / 5,000</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => agentLogDownload()}
              disabled={logCount === 0}
              className="btn"
              style={{ fontSize: 10 }}
              title={
                logCount === 0
                  ? "Buffer empty — turn the log on and reproduce the bug first"
                  : "Save the buffer as JSON"
              }
            >
              ▼ EXPORT JSON
            </button>
            <button
              onClick={onClear}
              disabled={logCount === 0}
              className="btn-ghost btn"
              style={{ fontSize: 10 }}
              title="Empty the buffer without exporting"
            >
              CLEAR
            </button>
          </div>
        </section>

        <p className="text-[11px] text-ink-soft leading-relaxed">
          Shortcut:{" "}
          <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">
            Shift+E
          </kbd>{" "}
          exports the log without opening this panel. See{" "}
          <code>docs/debug-teleport.md</code> for analysis tips.
        </p>
      </div>
    </div>
  );
}
