"use client";

import { useEffect, useState } from "react";
import { useGameStore } from "../stores/useGameStore";
import { useToastStore } from "../stores/useToastStore";
import DebugPanel from "./DebugPanel";
import { isEnabled as agentLogEnabled } from "../game/agentLog";

// HUD — compact overlays rendered INSIDE the game panel (it's the relative
// container). Only the controls hint + transient toasts live here in v2.0.
// The live-status chip and terminal toggle live elsewhere in MainSplit.
export default function HudOverlay() {
  const dialogActive = useGameStore((s) => s.dialog.active);
  const [debugOpen, setDebugOpen] = useState(false);
  // Re-render every couple seconds while the panel is closed so the
  // tiny 🐞 chip can show whether logging is currently recording.
  const [recording, setRecording] = useState(agentLogEnabled());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && (e.key === "D" || e.key === "d")) {
        const t = e.target as HTMLElement | null;
        if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA") return;
        e.preventDefault();
        setDebugOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Refresh the recording indicator when the panel closes (the user
  // may have just toggled the switch).
  useEffect(() => {
    if (debugOpen) return;
    setRecording(agentLogEnabled());
  }, [debugOpen]);

  return (
    <>
      {!dialogActive && <ControlsHint />}
      {!dialogActive && (
        <button
          type="button"
          onClick={() => setDebugOpen(true)}
          className="hud-chip hud-chip-interactive absolute top-2 right-2 z-20"
          title="Debug tools (Shift+D)"
          style={{ fontSize: 10 }}
        >
          {recording ? "🔴 LOG" : "🐞 DEBUG"}
        </button>
      )}
      <DebugPanel open={debugOpen} onClose={() => setDebugOpen(false)} />
      <ToastSlot />
    </>
  );
}

// Marquee-style controls hint. Auto-shows on mount for a few seconds,
// then fades away so the chip doesn't clutter the canvas. Hovering the
// game panel or pressing `?` brings it back via the shortcuts modal.
function ControlsHint() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    // Visible long enough to read the rolling text twice (~2 cycles
    // at 12 s each), then fade out.
    const t = setTimeout(() => setVisible(false), 8000);
    return () => clearTimeout(t);
  }, []);

  if (!visible) return null;

  return (
    <div
      className="hud-chip absolute bottom-2 right-2 z-10 overflow-hidden"
      style={{
        width: 160,
        opacity: visible ? 1 : 0,
        transition: "opacity 600ms ease",
      }}
    >
      <div
        className="whitespace-nowrap"
        style={{
          // The text is doubled inside so the loop seam is invisible.
          // Translates from 0 → -50% across MARQUEE_DURATION.
          animation: "hudMarquee 18s linear infinite",
        }}
      >
        DRAG &middot; SCROLL ZOOM &middot; CLICK AGENT &middot; HOVER FOR
        NAME &nbsp;&nbsp;&nbsp; DRAG &middot; SCROLL ZOOM &middot; CLICK
        AGENT &middot; HOVER FOR NAME &nbsp;&nbsp;&nbsp;
      </div>
    </div>
  );
}

// Transient one-slot toast. Bottom-center. Tone styles map to mint / amber /
// red left borders so feedback reads at a glance.
function ToastSlot() {
  const message = useToastStore((s) => s.message);
  const tone = useToastStore((s) => s.tone);
  if (!message) return null;
  const toneColor =
    tone === "error" ? "#ef4444" : tone === "warn" ? "#fbbf24" : "#6ee7b7";
  return (
    <div
      className="hud-chip absolute left-1/2 -translate-x-1/2 bottom-14 z-30 max-w-[80%] text-center"
      style={{
        fontSize: "10px",
        borderLeftWidth: 4,
        borderLeftColor: toneColor,
        animation: "fadeIn 0.2s ease-out",
      }}
    >
      {message}
    </div>
  );
}
