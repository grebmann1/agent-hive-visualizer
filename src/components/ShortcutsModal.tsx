"use client";

// ShortcutsModal — press `?` anywhere (outside an input/dialog) to open.
// Esc or clicking the backdrop closes it.

import { useEffect, useState } from "react";
import { useGameStore } from "../stores/useGameStore";

const SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: "Click floor + drag", label: "Pan the camera" },
  { keys: "Scroll wheel", label: "Zoom in / out" },
  { keys: "Click an agent", label: "Open its dialog" },
  { keys: "Right-click agent", label: "Context menu (follow, activity)" },
  { keys: "Space  /  Enter", label: "Advance dialog" },
  { keys: "Type + Enter", label: "Send a chat message" },
  { keys: "Esc", label: "Close dialog or cancel live agent call" },
  { keys: "⌘T", label: "Toggle embedded terminal split" },
  { keys: "⌘N", label: "New agent (QuickStart)" },
  { keys: "⌘`", label: "Switch focus between game and terminal" },
  { keys: "L", label: "Toggle event log in sidebar" },
  { keys: "D", label: "Toggle debug overlay (object borders + agent anchors)" },
  { keys: "Shift+E", label: "Export agent motion log (JSON download — for teleport debugging)" },
  { keys: "?", label: "Show this shortcut list" },
];

export default function ShortcutsModal() {
  const [open, setOpen] = useState(false);
  const dialogActive = useGameStore((s) => s.dialog.active);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (inInput) return;
      // `?` is Shift + `/` on US layouts. Use event.key for this — it's a
      // meta-char like Space or Enter, not a physical position.
      if (e.key === "?" && !dialogActive) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dialogActive]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="dialog-box w-[min(92vw,480px)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="pixel-font text-[13px] text-accent-dark">
            ◆ KEYBOARD SHORTCUTS
          </h2>
          <button
            onClick={() => setOpen(false)}
            className="pixel-font text-[9px] text-ink-soft hover:text-ink underline"
          >
            [CLOSE]
          </button>
        </div>
        <dl className="space-y-2">
          {SHORTCUTS.map((row) => (
            <div
              key={row.keys}
              className="flex items-baseline gap-3 text-[13px]"
            >
              <dt
                className="pixel-font text-[10px] shrink-0"
                style={{ minWidth: "180px" }}
              >
                {row.keys}
              </dt>
              <dd className="opacity-80">{row.label}</dd>
            </div>
          ))}
        </dl>
        <div className="text-[11px] text-ink-soft mt-4 pt-3 border-t-2 border-ink">
          Tip: press{" "}
          <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">
            ?
          </kbd>{" "}
          again to close this panel.
        </div>
      </div>
    </div>
  );
}
