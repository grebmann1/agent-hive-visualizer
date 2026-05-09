"use client";

import { useEffect, useState } from "react";
import { useGameStore } from "../stores/useGameStore";
import { useToastStore } from "../stores/useToastStore";

// HUD — compact overlays rendered INSIDE the game panel (it's the relative
// container). Only the controls hint + transient toasts live here in v2.0.
// The live-status chip and terminal toggle live elsewhere in MainSplit.
export default function HudOverlay() {
  const dialogActive = useGameStore((s) => s.dialog.active);

  return (
    <>
      {!dialogActive && <ControlsHint />}
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
