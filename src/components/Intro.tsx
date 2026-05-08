"use client";

// Lightweight first-launch welcome. Replaces the previous full-screen
// modal — most of its content is duplicated in the `?` shortcuts panel
// and the HookSetupBanner, so the modal mostly added friction.
//
// This component is a small chip pinned to the top-center of the canvas.
// It auto-dismisses when:
//   - the user clicks the X,
//   - the first dynamic agent appears (live activity is its own
//     onboarding signal — once an NPC walks in, the user has clearly
//     understood the loop),
//   - or the user has dismissed it before (localStorage flag).
//
// Pressing `?` opens the full shortcuts list, which is the canonical
// place for keyboard help. The chip just nudges new users toward it.

import { useEffect, useState } from "react";
import { useNpcStore } from "../stores/useNpcStore";

const DISMISSED_KEY = "agentquest_intro_seen_v4";

export default function Intro() {
  const [show, setShow] = useState(false);
  const dynamicCount = useNpcStore((s) => Object.keys(s.dynamic).length);

  useEffect(() => {
    try {
      if (!localStorage.getItem(DISMISSED_KEY)) setShow(true);
    } catch {
      setShow(true);
    }
  }, []);

  // Once any dynamic agent has joined, the welcome is no longer needed.
  // Mark it dismissed so it doesn't reappear next launch either.
  useEffect(() => {
    if (!show) return;
    if (dynamicCount === 0) return;
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // ignore
    }
    setShow(false);
  }, [show, dynamicCount]);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // ignore
    }
    setShow(false);
  };

  return (
    <div
      className="hud-chip fixed top-12 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3"
      style={{ pointerEvents: "auto" }}
    >
      <div className="flex flex-col gap-0.5">
        <div className="pixel-font text-[10px] text-accent-dark">
          ◆ WELCOME TO AGENT FORCE HQ
        </div>
        <div className="pixel-font text-[9px] text-ink-soft">
          Run <code>claude</code> in any project — your agent will appear here.
          Press <kbd>?</kbd> for shortcuts.
        </div>
      </div>
      <button
        onClick={dismiss}
        className="pixel-font text-[11px] text-ink-soft hover:text-ink"
        aria-label="Dismiss welcome"
        style={{ pointerEvents: "auto" }}
      >
        ×
      </button>
    </div>
  );
}
