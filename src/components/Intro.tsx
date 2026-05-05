"use client";

import { useEffect, useState } from "react";

const KEY = "agentquest_intro_seen_v3";

export default function Intro() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(KEY)) setShow(true);
    } catch {
      setShow(true);
    }
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // ignore
    }
    setShow(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="dialog-box max-w-lg w-full">
        <div className="pixel-font text-[13px] text-accent-dark mb-3">
          ◆ WELCOME TO AGENTQUEST
        </div>
        <p className="text-[15px] leading-relaxed mb-4">
          A 2D observatory for your local Claude agents. Every live{" "}
          <code>claude</code> session on your laptop appears here as a
          wandering NPC.
        </p>
        <ul className="space-y-2 mb-4 text-[14px]">
          <li>
            <span className="pixel-font text-[10px] text-accent-dark">▸</span>{" "}
            Drag the floor to pan · scroll to zoom
          </li>
          <li>
            <span className="pixel-font text-[10px] text-accent-dark">▸</span>{" "}
            Click an agent to chat · right-click for activity + follow
          </li>
          <li>
            <span className="pixel-font text-[10px] text-accent-dark">▸</span>{" "}
            <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">SPACE</kbd> advances dialog ·{" "}
            <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">ESC</kbd> closes it
          </li>
          <li>
            <span className="pixel-font text-[10px] text-accent-dark">▸</span>{" "}
            <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">⌘T</kbd> toggles embedded terminals ·{" "}
            <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">?</kbd> for all shortcuts
          </li>
        </ul>
        <p className="text-[13px] text-ink-soft mb-5">
          Install hooks on first run so AgentQuest can see agent activity in
          real time. No outbound network — everything runs over 127.0.0.1.
        </p>
        <button onClick={dismiss} className="btn btn-primary w-full">
          LET&apos;S GO ▸
        </button>
      </div>
    </div>
  );
}
