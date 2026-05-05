"use client";

import { useGameStore } from "../stores/useGameStore";
import { useNpcStore } from "../stores/useNpcStore";

export default function StatusStrip() {
  const dialogActive = useGameStore((s) => s.dialog.active);
  const dynamicCount = useNpcStore(
    (s) => Object.keys(s.dynamic).length,
  );

  return (
    <div className="flex items-center gap-3">
      <span
        className="pixel-font text-[9px] px-2 py-1 rounded"
        style={{
          background: dialogActive ? "#c9a959" : "#3a3e52",
          color: dialogActive ? "#1b1e2b" : "#f4ecd8",
        }}
      >
        {dialogActive ? "IN DIALOG" : "OBSERVING"}
      </span>
      <span className="pixel-font text-[9px] opacity-75">
        {dynamicCount} {dynamicCount === 1 ? "AGENT" : "AGENTS"}
      </span>
    </div>
  );
}
