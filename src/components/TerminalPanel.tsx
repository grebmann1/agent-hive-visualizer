"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { useTerminalStore } from "../stores/useTerminalStore";
import { useNpcStore } from "../stores/useNpcStore";
import { useWorldBus } from "../stores/useWorldBus";

// xterm pulls DOM APIs — dynamic import so SSR doesn't choke.
const TerminalInstance = dynamic(() => import("./TerminalInstance"), {
  ssr: false,
});

export default function TerminalPanel({
  onRequestNew,
}: {
  onRequestNew: () => void;
}) {
  const terminals = useTerminalStore((s) => s.terminals);
  const order = useTerminalStore((s) => s.order);
  const activeId = useTerminalStore((s) => s.activeTerminalId);
  const setActive = useTerminalStore((s) => s.setActive);
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);
  const markExited = useTerminalStore((s) => s.markExited);

  // Forward PTY exit → store. One global listener for the panel.
  useEffect(() => {
    const bridge = window.agentquest?.terminal;
    if (!bridge) return;
    const off = bridge.onExit(({ terminalId }) => {
      markExited(terminalId);
    });
    return off;
  }, [markExited]);

  // When a tab is clicked, also summon the linked NPC (if any).
  const handleTabClick = (terminalId: string) => {
    setActive(terminalId);
    const t = terminals[terminalId];
    if (t?.npcId) {
      useWorldBus.getState().summonAgent(t.npcId);
    }
  };

  const list = order.map((id) => terminals[id]).filter(Boolean);

  return (
    <div className="relative h-full min-h-0 flex flex-col panel-flush overflow-hidden">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b-2 border-ink bg-paper-dim">
        <div className="flex-1 flex items-center gap-1 overflow-x-auto">
          {list.length === 0 && (
            <span className="pixel-font text-[9px] text-ink-soft px-2">
              NO TERMINALS
            </span>
          )}
          {list.map((t) => {
            const isActive = t.id === activeId;
            const npc = t.npcId ? useNpcStore.getState().dynamic[t.npcId] : null;
            return (
              <div
                key={t.id}
                className="flex items-center rounded-t"
                style={{
                  background: isActive ? "var(--paper)" : "transparent",
                  borderLeft: "1px solid var(--border)",
                  borderRight: "1px solid var(--border)",
                  borderTop: isActive
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
                }}
              >
                <button
                  type="button"
                  onClick={() => handleTabClick(t.id)}
                  className={`pixel-font text-[9px] px-2 py-1 tracking-wide ${t.alive ? "" : "line-through opacity-60"}`}
                  title={`${t.cwd}${npc ? ` · ${npc.name}` : ""}`}
                >
                  {npc ? "● " : ""}
                  {t.title.toUpperCase()}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerminal(t.id);
                  }}
                  className="pixel-font text-[9px] px-1 text-ink-soft hover:text-ink"
                  title="Close terminal"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onRequestNew}
          className="pixel-font text-[9px] px-2 py-1 rounded border-2 border-ink bg-paper hover:bg-paper-dim tracking-wide"
          title="New terminal / agent"
        >
          + NEW
        </button>
      </div>

      <div className="relative flex-1 min-h-0">
        {list.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-center p-6">
            <div>
              <p className="pixel-font text-[10px] mb-3 tracking-wide">
                NO TERMINALS YET
              </p>
              <p className="text-[12px] opacity-75 mb-4 max-w-[300px]">
                Start a new shell or spin up a Claude agent directly inside
                AgentQuest.
              </p>
              <button
                type="button"
                onClick={onRequestNew}
                className="pixel-font text-[10px] px-3 py-2 rounded border-2 border-ink bg-accent text-ink hover:bg-accent-dark tracking-wide"
              >
                + NEW AGENT
              </button>
            </div>
          </div>
        ) : (
          list.map((t) => (
            <TerminalInstance
              key={t.id}
              terminalId={t.id}
              active={t.id === activeId}
            />
          ))
        )}
      </div>
    </div>
  );
}
