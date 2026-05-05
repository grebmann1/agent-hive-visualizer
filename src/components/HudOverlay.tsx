"use client";

import { useGameStore } from "../stores/useGameStore";
import { useToastStore } from "../stores/useToastStore";

// HUD — compact overlays rendered INSIDE the game panel (it's the relative
// container). Only the controls hint + transient toasts live here in v2.0.
// The live-status chip and terminal toggle live elsewhere in MainSplit.
export default function HudOverlay() {
  const dialogActive = useGameStore((s) => s.dialog.active);

  return (
    <>
      {/* BR slot — mouse/controls hint */}
      {!dialogActive && (
        <div className="hud-chip absolute bottom-2 right-2 z-10">
          DRAG &middot; SCROLL ZOOM &middot; CLICK AGENT
        </div>
      )}
      <ToastSlot />
    </>
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
