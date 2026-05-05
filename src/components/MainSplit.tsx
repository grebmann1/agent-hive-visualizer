"use client";

import { useEffect, useRef, useState } from "react";
import { useTerminalStore } from "../stores/useTerminalStore";
import DialogBox from "./DialogBox";
import GameCanvas from "./GameCanvas";
import HudOverlay from "./HudOverlay";
import LiveStatusChip from "./LiveStatusChip";
import QuickStartModal from "./QuickStartModal";
import TerminalPanel from "./TerminalPanel";

type Focus = "game" | "terminal";

// Hosts the left-hand column of the app: the game canvas + (when toggled)
// an embedded terminal panel sitting side-by-side with it.

export default function MainSplit() {
  const splitOpen = useTerminalStore((s) => s.splitOpen);
  const toggleSplit = useTerminalStore((s) => s.toggleSplit);
  const [quickOpen, setQuickOpen] = useState(false);
  const [focus, setFocus] = useState<Focus>("game");

  const gameFocusRef = useRef<HTMLDivElement | null>(null);
  const termFocusRef = useRef<HTMLDivElement | null>(null);

  // Focus helper — moves DOM focus to the right pane and flips state.
  // The game's keyboard handling is window-level (see WorldScene.setupInput)
  // so any focused element outside the xterm works; we park focus on the
  // game panel's wrapper div so xterm stops capturing keystrokes.
  const focusGame = () => {
    setFocus("game");
    gameFocusRef.current?.focus();
  };
  const focusTerm = () => {
    setFocus("terminal");
    // Let TerminalInstance's own effect focus the xterm; here we just flip
    // state and focus the wrapper so any pending Cmd+` handler sees it.
    termFocusRef.current?.focus();
    // Dispatch a tick so the currently-active xterm refits + focuses.
    window.dispatchEvent(new CustomEvent("agentquest:focus-terminal"));
  };

  // Keyboard plumbing:
  //   Cmd+T       → toggle terminal split
  //   Cmd+N       → new agent modal
  //   Cmd+`       → toggle focus game ↔ terminal (works FROM inside xterm)
  //   Escape      → always returns to the game (quick escape from terminal)
  //
  // Registered in capture phase so xterm.js can't swallow Cmd+`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const cmd = isMac ? e.metaKey : e.ctrlKey;

      // Cmd+` — focus toggle. Works regardless of the active element.
      if (cmd && (e.key === "`" || e.code === "Backquote")) {
        e.preventDefault();
        e.stopPropagation();
        if (!splitOpen) {
          // Open the split and focus the terminal in one shot.
          useTerminalStore.getState().setSplitOpen(true);
          setTimeout(focusTerm, 0);
          return;
        }
        if (focus === "game") focusTerm();
        else focusGame();
        return;
      }

      // Escape — when focus is in the terminal, bounce back to the game.
      // (xterm normally passes Escape through to the shell, but a top-level
      // escape to return focus is a near-universal convention.)
      if (e.key === "Escape" && focus === "terminal") {
        // Only hijack if Escape is pressed INSIDE an xterm textarea.
        const t = e.target as HTMLElement | null;
        const inXterm = t?.classList?.contains("xterm-helper-textarea");
        if (inXterm) {
          // Don't preventDefault — let the shell see Escape too, but also
          // return focus to the game so the next keystroke controls the
          // player. Users can still escape REPLs with plain Esc from the
          // game panel (no-op there).
          focusGame();
        }
        return;
      }

      if (!cmd) return;
      const t = e.target as HTMLElement | null;
      const isTextInput =
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");

      if (e.key === "t" || e.key === "T") {
        if (isTextInput && focus === "terminal") return;
        e.preventDefault();
        toggleSplit();
        return;
      }
      if (e.key === "n" || e.key === "N") {
        if (isTextInput && focus === "terminal") return;
        e.preventDefault();
        setQuickOpen(true);
        return;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [toggleSplit, focus, splitOpen]);

  // If the split closes, ensure focus drops back to the game.
  useEffect(() => {
    if (!splitOpen && focus === "terminal") {
      setFocus("game");
    }
  }, [splitOpen, focus]);

  return (
    <section className="space-y-3 min-w-0 flex flex-col lg:h-[calc(100vh-4.5rem)]">
      <div
        className={
          splitOpen
            ? "grid grid-cols-[1fr_1fr] gap-3 flex-1 min-h-0"
            : "flex flex-1 min-h-0"
        }
      >
        <div
          ref={gameFocusRef}
          tabIndex={-1}
          onMouseDown={focusGame}
          className="relative panel-flush min-h-0 h-full w-full overflow-hidden outline-none"
          style={{
            boxShadow:
              splitOpen && focus === "game"
                ? "0 0 0 2px var(--accent)"
                : undefined,
          }}
        >
          <GameCanvas />
          <HudOverlay />
          <DialogBox />
          {/* TR slot — live-status chip stacked above the terminal toggle */}
          <div className="absolute top-2 right-2 z-20 flex flex-col items-end gap-2">
            <LiveStatusChip />
            <button
              type="button"
              onClick={toggleSplit}
              className="hud-chip hud-chip-interactive"
              title="Toggle embedded terminals (⌘T) · Switch focus (⌘`)"
            >
              {splitOpen ? "HIDE TERMINAL" : "⌨ TERMINAL"}
            </button>
          </div>
          {/* BL slot — focus hint (moved from TL to avoid colliding with room chip) */}
          {splitOpen && focus === "terminal" && (
            <div className="hud-chip absolute bottom-2 left-2 z-20">
              ⌘` TO FOCUS GAME
            </div>
          )}
        </div>
        {splitOpen && (
          <div
            ref={termFocusRef}
            tabIndex={-1}
            onMouseDown={focusTerm}
            className="min-h-0 h-full outline-none"
            style={{
              boxShadow:
                focus === "terminal" ? "0 0 0 2px var(--accent)" : undefined,
              borderRadius: 6,
            }}
          >
            <TerminalPanel onRequestNew={() => setQuickOpen(true)} />
          </div>
        )}
      </div>
      <QuickStartModal open={quickOpen} onClose={() => setQuickOpen(false)} />
    </section>
  );
}
