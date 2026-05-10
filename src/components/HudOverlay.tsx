"use client";

import { useEffect, useState } from "react";
import { useGameStore } from "../stores/useGameStore";
import { useToastStore } from "../stores/useToastStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import DebugPanel from "./DebugPanel";
import { isEnabled as agentLogEnabled } from "../game/agentLog";

// HUD — compact overlays rendered INSIDE the game panel (it's the relative
// container). Only the controls hint + transient toasts live here in v2.0.
// The live-status chip and terminal toggle live elsewhere in MainSplit.
export default function HudOverlay() {
  const dialogActive = useGameStore((s) => s.dialog.active);
  const calmMode = useSettingsStore((s) => s.calmMode);
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
      {!dialogActive && (
        <div className="absolute top-2 right-2 z-20 flex items-center gap-1">
          <button
            type="button"
            onClick={() => useSettingsStore.getState().toggleCalmMode()}
            aria-pressed={calmMode}
            aria-label={calmMode ? "Calm mode active" : "Enable calm mode"}
            className="hud-chip hud-chip-interactive"
            title="Toggle calm mode (reduce motion/chatter)"
            style={{ fontSize: 10 }}
          >
            {calmMode ? "🧘 Active" : "🧘 Calm"}
          </button>
          <button
            type="button"
            onClick={() => setDebugOpen(true)}
            aria-label={
              recording
                ? "Debug tools (currently recording motion log)"
                : "Open debug tools"
            }
            className="hud-chip hud-chip-interactive"
            title="Debug tools (Shift+D)"
            style={{ fontSize: 10 }}
          >
            {recording ? "🔴 LOG" : "🐞 DEBUG"}
          </button>
        </div>
      )}
      <DebugPanel open={debugOpen} onClose={() => setDebugOpen(false)} />
      <ToastSlot />
    </>
  );
}

// Transient one-slot toast. Bottom-center. Tone styles map to mint / amber /
// red left borders so feedback reads at a glance.
//
// We mirror the store's `message` into local state so when the store clears
// (after auto-hide or click dismiss), we can fade the chip OUT for ~250ms
// before unmounting it instead of popping abruptly.
function ToastSlot() {
  const message = useToastStore((s) => s.message);
  const tone = useToastStore((s) => s.tone);
  const [displayMessage, setDisplayMessage] = useState<string | null>(null);
  const [displayTone, setDisplayTone] = useState<"info" | "warn" | "error">(
    "info",
  );
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (message) {
      // New (or replacement) toast: show immediately, cancel any pending
      // fade-out so a fresh toast doesn't get cut off mid-exit.
      setDisplayMessage(message);
      setDisplayTone(tone);
      setExiting(false);
      return;
    }
    // Store cleared but we may still be displaying — kick off the fade-out.
    if (displayMessage !== null) {
      setExiting(true);
      const t = setTimeout(() => {
        setDisplayMessage(null);
        setExiting(false);
      }, 250);
      return () => clearTimeout(t);
    }
  }, [message, tone, displayMessage]);

  if (!displayMessage) return null;
  const toneColor =
    displayTone === "error"
      ? "#ef4444"
      : displayTone === "warn"
        ? "#fbbf24"
        : "#6ee7b7";
  return (
    <div
      onClick={() => useToastStore.getState().hide()}
      className="hud-chip hud-chip-interactive absolute left-1/2 -translate-x-1/2 bottom-14 z-30 max-w-[80%] text-center"
      title="Click to dismiss"
      style={{
        fontSize: "10px",
        borderLeftWidth: 4,
        borderLeftColor: toneColor,
        cursor: "pointer",
        animation: exiting
          ? "fadeOut 250ms ease forwards"
          : "fadeIn 0.2s ease-out",
      }}
    >
      {displayMessage}
    </div>
  );
}
