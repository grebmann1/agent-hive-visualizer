"use client";

import { useEffect, useMemo, useState } from "react";
import { useActivityModalStore } from "../stores/useActivityModalStore";
import { useAgentStore } from "../stores/useAgentStore";
import { useNpcStore } from "../stores/useNpcStore";
import type { DynamicNpc } from "../stores/useNpcStore";
import { useTerminalStore } from "../stores/useTerminalStore";
import { npcById } from "../game/npcs";
import { buildToolMessage, shortPath } from "./tool-format";

const THINKING_SNIPPET_LEN = 120;
const RESULT_SNIPPET_LEN = 160;

type EventMeta = {
  isError?: boolean;
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
  resultText?: string;
  text?: string;
};

export default function ActivityModal() {
  const open = useActivityModalStore((s) => s.open);
  const npcId = useActivityModalStore((s) => s.npcId);
  const close = useActivityModalStore((s) => s.close);
  const events = useAgentStore((s) => s.events);
  const usageByAgent = useAgentStore((s) => s.usageByAgent);
  const sessionByAgent = useAgentStore((s) => s.sessionByAgent);
  const dynamics = useNpcStore((s) => s.dynamic);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showTools, setShowTools] = useState(true);
  const [showThinking, setShowThinking] = useState(true);
  const [showChat, setShowChat] = useState(true);

  const npc = useMemo(() => {
    if (!npcId) return null;
    return dynamics[npcId] ?? npcById(npcId) ?? null;
  }, [npcId, dynamics]);

  const agentEvents = useMemo(() => {
    if (!npcId) return [];
    return events.filter((e) => e.agentId === npcId);
  }, [events, npcId]);

  // Lookup table: toolUseId -> tool_use event (for duration + toolName resolution)
  const toolUseById = useMemo(() => {
    const map = new Map<
      string,
      { timestamp: string; toolName?: string }
    >();
    for (const ev of agentEvents) {
      const meta = (ev.metadata ?? {}) as EventMeta;
      if (
        ev.type === "agent.state.changed" &&
        meta.toolUseId &&
        meta.toolName
      ) {
        map.set(meta.toolUseId, {
          timestamp: ev.timestamp,
          toolName: meta.toolName,
        });
      }
    }
    return map;
    // Intentionally memoize on length — events array grows append-only per the store.
  }, [agentEvents.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = useMemo(() => {
    const reversed = agentEvents.slice().reverse();
    return reversed.filter((e) => {
      const meta = (e.metadata ?? {}) as EventMeta;
      const isToolEvent =
        (e.type === "agent.state.changed" && !!meta.toolName) ||
        e.type === "agent.tool.result";
      const isThinking = e.type === "agent.thinking";
      const isChat =
        (e.type === "agent.state.changed" &&
          e.state === "summarizing" &&
          !meta.toolName) ||
        e.type === "agent.session";
      if (isToolEvent) return showTools;
      if (isThinking) return showThinking;
      if (isChat) return showChat;
      return true;
    });
  }, [agentEvents, showTools, showThinking, showChat]);

  const usage = npcId ? usageByAgent[npcId] : undefined;
  const session = npcId ? sessionByAgent[npcId] : undefined;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Reset expand state when switching agent / closing
  useEffect(() => {
    setExpanded(new Set());
  }, [npcId, open]);

  if (!open) return null;

  const dynNpc = npc as (DynamicNpc & { external?: boolean }) | null;
  const hasTerminal = !!dynNpc?.terminalId;
  const isExternal = dynNpc?.external === true;

  const onTerminalClick = () => {
    if (!dynNpc?.terminalId) return;
    const ts = useTerminalStore.getState();
    ts.setActive(dynNpc.terminalId);
    ts.setSplitOpen(true);
  };

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
      onClick={close}
    >
      <div
        className="dialog-box w-[min(92vw,560px)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2">
          <h2 className="pixel-font text-[13px] text-accent-dark">
            ◆ ACTIVITY · {(npc?.name ?? npcId ?? "").toUpperCase()}
          </h2>
          <button
            type="button"
            onClick={close}
            className="pixel-font text-[9px] text-ink-soft hover:text-ink underline"
          >
            [CLOSE]
          </button>
        </div>

        {(session || usage || dynNpc) && (
          <div className="mb-3 pb-2 border-b-2 border-ink flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            {session?.model && (
              <span className="pixel-font text-[9px] text-ink-soft tracking-wide">
                MODEL · <span className="text-ink">{session.model}</span>
              </span>
            )}
            {session?.sessionId && (
              <span className="pixel-font text-[9px] text-ink-soft tracking-wide">
                SESSION ·{" "}
                <span className="text-ink">
                  {session.sessionId.slice(0, 8)}
                </span>
              </span>
            )}
            {usage && (
              <span className="pixel-font text-[9px] text-ink-soft tracking-wide">
                TOKENS ·{" "}
                <span className="text-ink">
                  ↓{formatNum(usage.input)} ↑{formatNum(usage.output)}
                </span>
                {usage.cacheRead > 0 && (
                  <span className="text-ink-soft">
                    {" "}
                    (cache {formatNum(usage.cacheRead)})
                  </span>
                )}
              </span>
            )}
            {usage && (
              <span className="pixel-font text-[9px] text-ink-soft tracking-wide">
                TURNS · <span className="text-ink">{usage.turns}</span>
              </span>
            )}
            {dynNpc?.cwd && (
              <span className="pixel-font text-[9px] text-ink-soft tracking-wide">
                CWD · <span className="text-ink">{shortPath(dynNpc.cwd)}</span>
              </span>
            )}
            {typeof dynNpc?.pid === "number" && (
              <span className="pixel-font text-[9px] text-ink-soft tracking-wide">
                PID · <span className="text-ink">{dynNpc.pid}</span>
              </span>
            )}
            {hasTerminal ? (
              <button
                type="button"
                onClick={onTerminalClick}
                className="pixel-font text-[9px] tracking-wide px-1.5 py-0.5 rounded border border-ink bg-paper-dim hover:bg-accent hover:text-ink cursor-pointer"
                title="Focus the terminal that started this agent"
              >
                ⌨ TERM
              </button>
            ) : isExternal ? (
              <span className="pixel-font text-[9px] text-ink-soft tracking-wide">
                SOURCE · <span className="text-ink">External</span>
              </span>
            ) : null}
          </div>
        )}

        {/* Filter chips */}
        <div className="flex items-center gap-1.5 mb-2">
          <button
            type="button"
            onClick={() => setShowTools((v) => !v)}
            className="pixel-font text-[9px] px-2 py-1 rounded border-2 border-ink tracking-wide"
            style={{
              background: showTools ? "var(--accent)" : "var(--paper-dim)",
              color: showTools ? "var(--ink)" : "var(--ink-soft)",
            }}
          >
            {showTools ? "● " : "○ "}TOOLS
          </button>
          <button
            type="button"
            onClick={() => setShowThinking((v) => !v)}
            className="pixel-font text-[9px] px-2 py-1 rounded border-2 border-ink tracking-wide"
            style={{
              background: showThinking ? "var(--accent)" : "var(--paper-dim)",
              color: showThinking ? "var(--ink)" : "var(--ink-soft)",
            }}
          >
            {showThinking ? "● " : "○ "}THINKING
          </button>
          <button
            type="button"
            onClick={() => setShowChat((v) => !v)}
            className="pixel-font text-[9px] px-2 py-1 rounded border-2 border-ink tracking-wide"
            style={{
              background: showChat ? "var(--accent)" : "var(--paper-dim)",
              color: showChat ? "var(--ink)" : "var(--ink-soft)",
            }}
          >
            {showChat ? "● " : "○ "}CHAT
          </button>
        </div>

        {entries.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-[13px] opacity-70">
              No activity recorded yet for this agent.
            </p>
          </div>
        ) : (
          <ul
            className="pixel-scroll overflow-y-auto pr-1 space-y-2"
            style={{ maxHeight: "60vh" }}
          >
            {entries.map((e, i) => {
              const when = formatTime(e.timestamp);
              const label = e.state ?? e.type.replace(/^agent\./, "");
              const meta = (e.metadata ?? {}) as EventMeta;
              const isResult = e.type === "agent.tool.result";
              const isError = isResult && meta.isError;
              const isThinking = e.type === "agent.thinking";
              const borderColor = isError
                ? "#ef4444"
                : isResult
                  ? "#22c55e"
                  : undefined;
              const marker = isError ? "✕" : isResult ? "✓" : null;

              // Resolve tool name for this row: prefer meta.toolName; for
              // tool_result, look up via toolUseId.
              const resolvedToolName = meta.toolName
                ? meta.toolName
                : isResult && meta.toolUseId
                  ? toolUseById.get(meta.toolUseId)?.toolName
                  : undefined;

              // Inline tool summary (Running: ls, Reading src/foo.ts, etc.).
              const toolSummary =
                e.type === "agent.state.changed" && meta.toolName
                  ? buildToolMessage(meta.toolName, meta.input)
                  : null;

              // Duration chip for tool_result events
              let durationChip: string | null = null;
              if (isResult && meta.toolUseId) {
                const usage = toolUseById.get(meta.toolUseId);
                if (usage) {
                  const dt =
                    new Date(e.timestamp).getTime() -
                    new Date(usage.timestamp).getTime();
                  if (!Number.isNaN(dt) && dt >= 0) {
                    durationChip = formatDuration(dt);
                  }
                }
              }

              // Expandable body
              const key = `${e.timestamp}-${i}`;
              const isOpen = expanded.has(key);
              const fullText = isThinking
                ? (meta.text ?? e.message ?? "")
                : isResult
                  ? (meta.resultText ?? e.message ?? "")
                  : "";
              const snippetLen = isThinking
                ? THINKING_SNIPPET_LEN
                : RESULT_SNIPPET_LEN;
              const hasExpandable =
                (isThinking || isResult) &&
                typeof fullText === "string" &&
                fullText.length > snippetLen;

              const displayMessage = (() => {
                if (!isThinking && !isResult) return e.message;
                if (!hasExpandable) return fullText || e.message;
                if (isOpen) return null; // show full in <pre> below
                return `${fullText.slice(0, snippetLen).trimEnd()}…`;
              })();

              const rowClickable = hasExpandable;

              return (
                <li
                  key={key}
                  className={
                    "border-l-2 pl-3 py-1" +
                    (rowClickable ? " cursor-pointer" : "")
                  }
                  style={{ borderColor: borderColor ?? "var(--border)" }}
                  onClick={
                    rowClickable ? () => toggleExpanded(key) : undefined
                  }
                >
                  <div className="flex items-baseline gap-2 mb-0.5">
                    {rowClickable && (
                      <span className="pixel-font text-[9px] text-ink-soft select-none">
                        {isOpen ? "▾" : "▸"}
                      </span>
                    )}
                    <span className="pixel-font text-[9px] text-ink-soft">
                      {when}
                    </span>
                    <span className="pixel-font text-[9px] px-1.5 py-0.5 rounded bg-paper-dim border border-ink tracking-wide">
                      {label.toUpperCase()}
                    </span>
                    {resolvedToolName && (
                      <span className="pixel-font text-[9px] text-ink-soft tracking-wide">
                        {resolvedToolName}
                      </span>
                    )}
                    {marker && (
                      <span
                        className="pixel-font text-[10px]"
                        style={{ color: isError ? "#ef4444" : "#22c55e" }}
                      >
                        {marker}
                      </span>
                    )}
                    {durationChip && (
                      <span className="pixel-font text-[9px] text-ink-soft">
                        +{durationChip}
                      </span>
                    )}
                  </div>
                  {toolSummary && (
                    <div className="text-[11px] font-mono text-ink-soft leading-snug mb-0.5">
                      {toolSummary}
                    </div>
                  )}
                  {displayMessage != null && displayMessage !== "" && (
                    <div className="text-[13px] leading-snug text-ink">
                      {displayMessage}
                    </div>
                  )}
                  {isOpen && hasExpandable && (
                    <pre className="whitespace-pre-wrap text-[11px] font-mono bg-paper-dim p-2 rounded mt-1">
                      {fullText}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}
