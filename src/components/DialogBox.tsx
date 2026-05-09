"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { npcById } from "../game/npcs";
import { useAgentStore } from "../stores/useAgentStore";
import { useGameStore, type DialogLine } from "../stores/useGameStore";
import { useNpcStore, type DynamicNpc } from "../stores/useNpcStore";
import { useTerminalStore } from "../stores/useTerminalStore";
import LiveThread from "./LiveThread";
import { buildToolMessage } from "./tool-format";
import type { AgentState } from "../events/types";
import type {
  AskClaudeHandle,
  AskClaudeStreamEvent,
} from "./ClaudeMonitorBridge";

const TYPE_SPEED_CPS = 60;
const CHARS_PER_PAGE = 240;

export default function DialogBox() {
  const dialog = useGameStore((s) => s.dialog);
  const shiftLine = useGameStore((s) => s.shiftLine);
  const enqueueLine = useGameStore((s) => s.enqueueLine);
  const startStreamingLine = useGameStore((s) => s.startStreamingLine);
  const appendToStreamingLine = useGameStore((s) => s.appendToStreamingLine);
  const finishStreamingLine = useGameStore((s) => s.finishStreamingLine);
  const setToolStatus = useGameStore((s) => s.setToolStatus);
  const closeDialog = useGameStore((s) => s.closeDialog);
  const setAwaitingInput = useGameStore((s) => s.setAwaitingInput);
  const setThinking = useGameStore((s) => s.setThinking);
  const pushAgentEvent = useAgentStore((s) => s.pushEvent);
  // Subscribe reactively so the one-line header strip updates when the
  // transcript watcher posts the `agent.session` (model/sessionId) event.
  const sessionByAgent = useAgentStore((s) => s.sessionByAgent);

  // Pull the live dynamic record + linked terminal for the NPC currently
  // in dialog. Subscribing to the whole `dynamic` + `terminals` maps is
  // fine: both are tiny, and we need reactivity so the LiveThread surface
  // appears as soon as the NPC's terminal is registered and dies visually
  // when the terminal exits.
  const npcId = dialog.npcId;
  const dyn = useNpcStore((s) => (npcId ? s.dynamic[npcId] : undefined));
  const terminals = useTerminalStore((s) => s.terminals);
  const setActiveTerminal = useTerminalStore((s) => s.setActive);
  const setSplitOpen = useTerminalStore((s) => s.setSplitOpen);
  const termId = dyn?.terminalId;
  const termAlive = termId ? terminals[termId]?.alive === true : false;
  // Synced mode = this NPC is tied to one of our embedded terminals AND
  // the terminal is still alive. In sync mode the dialog routes input
  // straight to the PTY and renders LiveThread instead of the classic
  // typewriter queue.
  const syncMode = !!(termId && termAlive);
  const session = npcId ? sessionByAgent[npcId] : undefined;

  const currentLine: DialogLine | undefined = dialog.queue[0];
  const isCurrentStreaming =
    !!currentLine && currentLine.id === dialog.streamingLineId;
  const isStreamingActive = dialog.streamingLineId !== null;

  const [revealed, setRevealed] = useState("");
  const [done, setDone] = useState(false);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The streaming-text container — we pin scroll to the bottom each
  // time `revealed` grows so long replies don't slide out of view.
  const lineScrollRef = useRef<HTMLDivElement | null>(null);
  const conversationRef = useRef<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);
  const askHandleRef = useRef<AskClaudeHandle | null>(null);

  // Typewriter effect on the current line.
  // For a STREAMING line we skip the typewriter — text arrives naturally
  // one chunk at a time, already paced by the network.
  useEffect(() => {
    if (!currentLine) {
      setRevealed("");
      setDone(false);
      return;
    }
    if (isCurrentStreaming) {
      // Show text as it arrives; "done" is controlled by finishStreamingLine.
      setRevealed(currentLine.text);
      setDone(!isStreamingActive);
      return;
    }
    // Non-streaming: classic typewriter that resets when the line id changes.
    setRevealed("");
    setDone(false);
    const text = currentLine.text;
    let i = 0;
    const interval = 1000 / TYPE_SPEED_CPS;
    const t = setInterval(() => {
      i++;
      setRevealed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(t);
        setDone(true);
      }
    }, interval);
    return () => clearInterval(t);
    // Only (re)start when the id changes. For non-streaming lines text is
    // immutable after the line is enqueued, so text doesn't need to be in deps.
  }, [currentLine?.id, isCurrentStreaming, isStreamingActive, currentLine]);

  useEffect(() => {
    if (dialog.active) {
      conversationRef.current = [];
      setInput("");
    }
  }, [dialog.active, dialog.npcId]);

  // Pin scroll to the bottom whenever the visible line grows so long
  // streaming replies stay readable instead of disappearing past the
  // dialog's max-height.
  useEffect(() => {
    const el = lineScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [revealed]);

  useEffect(() => {
    if (!dialog.active) {
      const h = askHandleRef.current;
      if (h) {
        try {
          h.cancel();
        } catch {
          /* ignore */
        }
        try {
          h.dispose();
        } catch {
          /* ignore */
        }
        askHandleRef.current = null;
      }
    }
    return () => {
      const h = askHandleRef.current;
      if (h) {
        try {
          h.cancel();
        } catch {
          /* ignore */
        }
        try {
          h.dispose();
        } catch {
          /* ignore */
        }
        askHandleRef.current = null;
      }
    };
  }, [dialog.active, dialog.npcId]);

  useEffect(() => {
    if (dialog.awaitingInput) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [dialog.awaitingInput]);

  // In synced mode we always show an input, so focus as soon as the
  // dialog opens (or when the sync-mode flag flips true mid-conversation
  // because the terminal just registered with the NPC).
  useEffect(() => {
    if (syncMode && dialog.active) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [syncMode, dialog.active]);

  useEffect(() => {
    if (!dialog.active) return;
    if (
      dialog.queue.length === 0 &&
      !dialog.awaitingInput &&
      !dialog.isThinking &&
      !isStreamingActive
    ) {
      setAwaitingInput(true);
    }
  }, [
    dialog.active,
    dialog.queue.length,
    dialog.awaitingInput,
    dialog.isThinking,
    isStreamingActive,
    setAwaitingInput,
  ]);

  useEffect(() => {
    if (!dialog.active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (e.key === "Escape") {
        if (!inInput) {
          e.preventDefault();
          cancelInFlight();
          closeDialog();
        }
        return;
      }
      if (inInput) return;
      if (
        e.key === " " ||
        e.key === "Enter" ||
        e.key === "e" ||
        e.key === "E"
      ) {
        e.preventDefault();
        if (!currentLine) return;
        // Don't auto-advance while a line is actively streaming in —
        // the player can wait or press [CANCEL] to abort.
        if (isCurrentStreaming && isStreamingActive) return;
        if (!done) {
          setRevealed(currentLine.text);
          setDone(true);
        } else {
          shiftLine();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dialog.active,
    currentLine,
    done,
    shiftLine,
    closeDialog,
    isCurrentStreaming,
    isStreamingActive,
  ]);

  const cancelInFlight = () => {
    const h = askHandleRef.current;
    if (h) {
      try {
        h.cancel();
      } catch {
        /* ignore */
      }
      try {
        h.dispose();
      } catch {
        /* ignore */
      }
      askHandleRef.current = null;
    }
    finishStreamingLine();
    setThinking(false);
  };

  if (!dialog.active) return null;

  // Stream a user message through a real `claude -p` subprocess running in
  // the NPC's cwd. Deltas are appended to a streaming line in real time; when
  // the subprocess finishes, the line is finalized and split into extra pages
  // if it got long.
  const sendViaLocalClaude = (dyn: DynamicNpc, text: string): Promise<void> => {
    return new Promise((resolve) => {
      // Route through the agent registry — any provider that supports
      // `ask()` can handle this. Currently only HookProvider does,
      // but the path is provider-agnostic.
      // Lazy-import to avoid loading the registry during SSR.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const registry = require("../agents/registry") as typeof import("../agents/registry");
      // registry.ask is not exported directly; we go through the API the
      // registry hands to the provider via createAPI. For UI callers we add
      // a thin helper.
      const askAgent = (id: string, prompt: string,
                       onEvent: (e: AskClaudeStreamEvent) => void) => {
        // createAPI returns ask() — but it's per-provider, not exported.
        // Shortcut: invoke the first registered provider's ask path via
        // its known internal surface. In practice only HookProvider
        // implements `askViaProvider`.
        const provider = registry
          .listProviders()
          .find(
            (p) =>
              typeof (p as unknown as { askViaProvider?: unknown })
                .askViaProvider === "function",
          );
        if (!provider) return undefined;
        return (
          provider as unknown as {
            askViaProvider: (
              id: string,
              prompt: string,
              onEvent: (e: AskClaudeStreamEvent) => void,
            ) => AskClaudeHandle | undefined;
          }
        ).askViaProvider(id, prompt, onEvent);
      };
      if (!dyn.cwd) {
        enqueueLine({
          source: "system",
          text: "…couldn't reach the local agent. Try again?",
        });
        resolve();
        return;
      }
      if (askHandleRef.current) {
        try {
          askHandleRef.current.cancel();
        } catch {
          /* ignore */
        }
        try {
          askHandleRef.current.dispose();
        } catch {
          /* ignore */
        }
        askHandleRef.current = null;
      }

      let finished = false;
      let streamingStarted = false;
      let accumulatedForHistory = "";

      const finish = () => {
        if (finished) return;
        finished = true;
        const h = askHandleRef.current;
        if (h) {
          try {
            h.dispose();
          } catch {
            /* ignore */
          }
        }
        askHandleRef.current = null;
        finishStreamingLine();
        setToolStatus(null);
        resolve();
      };

      const handle = askAgent(
        dyn.id,
        text,
        (event: AskClaudeStreamEvent) => {
          if (finished) return;
          if (event.type === "text" && typeof event.delta === "string") {
            if (!streamingStarted) {
              streamingStarted = true;
              setThinking(false);
              startStreamingLine({
                source: "npc",
                speaker: dyn.name,
                text: event.delta,
              });
              accumulatedForHistory = event.delta;
            } else {
              appendToStreamingLine(event.delta);
              accumulatedForHistory += event.delta;
            }
            return;
          }
          if (event.type === "tool_use") {
            const msg = buildToolMessage(event.toolName, event.input);
            setToolStatus(msg);
            pushAgentEvent({
              type: "agent.state.changed",
              agentId: dyn.id,
              state: toolNameToState(event.toolName),
              message: msg,
              timestamp: new Date().toISOString(),
              metadata: { toolName: event.toolName },
            });
            return;
          }
          if (event.type === "done") {
            const finalText =
              (typeof event.fullText === "string" && event.fullText) ||
              accumulatedForHistory ||
              "…";
            if (!streamingStarted) {
              // No deltas arrived (rare) — enqueue the whole thing at once.
              const pages = splitIntoPages(finalText, CHARS_PER_PAGE);
              for (const page of pages) {
                enqueueLine({ source: "npc", speaker: dyn.name, text: page });
              }
            } else if (finalText.length > accumulatedForHistory.length) {
              // fullText differs (non-streamed final content) — append the rest
              appendToStreamingLine(
                finalText.slice(accumulatedForHistory.length),
              );
            }
            conversationRef.current.push({
              role: "assistant",
              content: finalText,
            });
            finish();
            return;
          }
          if (event.type === "error") {
            if (streamingStarted) {
              appendToStreamingLine("\n…(the radio cut out)");
            } else {
              enqueueLine({
                source: "system",
                text: "…the radio cut out. Try again?",
              });
            }
            console.error("[agentquest] claude -p error:", event.message);
            finish();
            return;
          }
        },
      );
      if (!handle) {
        enqueueLine({
          source: "system",
          text: "…no provider available to ask this agent.",
        });
        resolve();
        return;
      }
      askHandleRef.current = handle;
    });
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text) return;
    if (!dialog.npcId) return;

    setInput("");
    setAwaitingInput(false);
    enqueueLine({ source: "player", text });
    conversationRef.current.push({ role: "user", content: text });

    setThinking(true);

    try {
      const dyn = useNpcStore.getState().dynamic[dialog.npcId];
      // Synced mode: if the NPC was spawned from one of our embedded
      // terminals AND that terminal is still alive, write the message
      // straight into the PTY. The hook pipeline surfaces the reply
      // through useAgentStore so LiveThread renders it automatically.
      // One claude, two surfaces.
      const termId = dyn?.terminalId;
      const termAlive = termId
        ? useTerminalStore.getState().terminals[termId]?.alive
        : false;
      if (termId && termAlive) {
        await window.agentquest?.terminal?.write(termId, text + "\n");
        setThinking(true); // cleared by the first streamed event
        return;
      }
      // Prefer the provider-registry path for any agent with a cwd. Falls
      // back to the fake /api/chat Haiku route when running in a browser
      // (no Electron bridge) or when no provider can serve this agent.
      if (dyn && dyn.cwd) {
        await sendViaLocalClaude(dyn, text);
        return;
      }
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          npcId: dialog.npcId,
          userMessage: text,
          history: conversationRef.current.slice(0, -1),
          personaName: dyn?.name,
          systemPrompt: dyn?.systemPrompt,
        }),
      });
      const data = (await res.json()) as {
        reply?: string;
        fallback?: string;
        error?: string;
        states?: string[];
      };
      const reply = data.reply ?? data.fallback ?? "…";
      const npc = npcById(dialog.npcId);
      if (!npc) return;

      const states = data.states ?? [];
      for (const state of states) {
        pushAgentEvent({
          type: "agent.state.changed",
          agentId: npc.id,
          state: state as never,
          message: `${npc.name} is ${state.replace(/_/g, " ")}...`,
          timestamp: new Date().toISOString(),
        });
      }

      const pages = splitIntoPages(reply, CHARS_PER_PAGE);
      for (const page of pages) {
        enqueueLine({ source: "npc", speaker: npc.name, text: page });
      }
      conversationRef.current.push({ role: "assistant", content: reply });
    } catch (err) {
      enqueueLine({
        source: "system",
        text: "…the connection cuts out for a moment. Try again?",
      });
      console.error("chat failed", err);
    } finally {
      setThinking(false);
    }
  };

  const handleInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendMessage();
    } else if (e.key === "Escape") {
      cancelInFlight();
      closeDialog();
    }
  };

  const line = currentLine;
  const speaker = line?.speaker;
  const showCancel = dialog.isThinking || isStreamingActive;

  // Terminal-linked session chip row. Only shown when the NPC has a
  // terminal attached — clicking the TERM chip swings the split panel
  // open and focuses that terminal so the user gets reciprocal focus.
  const headerStrip = termId ? (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 pb-2 border-b-2 border-ink">
      {session?.model && (
        <span className="pixel-font text-[9px] text-ink-soft tracking-wide">
          MODEL · <span className="text-ink">{session.model}</span>
        </span>
      )}
      {session?.sessionId && (
        <span className="pixel-font text-[9px] text-ink-soft tracking-wide">
          SESSION ·{" "}
          <span className="text-ink">{session.sessionId.slice(0, 8)}</span>
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          setActiveTerminal(termId);
          setSplitOpen(true);
        }}
        className="pixel-font text-[9px] px-1.5 py-0.5 rounded border border-ink bg-paper-dim hover:bg-white text-ink tracking-wide"
        title="Focus the linked terminal"
      >
        ⌨ TERM
      </button>
      {!termAlive && (
        <span
          className="pixel-font text-[9px] tracking-wide"
          style={{ color: "#ef4444" }}
        >
          · DEAD
        </span>
      )}
    </div>
  ) : null;

  return (
    <div className="absolute left-3 right-3 bottom-3 z-40 pointer-events-auto">
      <div className="dialog-box">
        {headerStrip}
        {line && speaker && (
          <div className="flex items-center justify-between mb-2">
            <div className="pixel-font text-[11px] text-accent-dark tracking-wide">
              ◆ {speaker.toUpperCase()}
            </div>
            {showCancel && (
              <button
                onClick={cancelInFlight}
                className="pixel-font text-[9px] px-2 py-1 rounded border-2 border-ink bg-paper-dim hover:bg-white text-ink tracking-wide"
              >
                [CANCEL]
              </button>
            )}
          </div>
        )}
        {dialog.toolStatus && showCancel && !syncMode && (
          <div className="text-[12px] italic text-ink-soft mb-2">
            ⚙ {dialog.toolStatus}
          </div>
        )}
        {syncMode && npcId ? (
          <LiveThread
            agentId={npcId}
            agentName={dyn?.name ?? ""}
            onSessionDead={termId ? !termAlive : false}
          />
        ) : (
        <div
          ref={lineScrollRef}
          className="min-h-[88px] max-h-[260px] overflow-y-auto pixel-scroll text-[15px] leading-[1.6] text-ink"
        >
          {line ? (
            <>
              {line.source === "player" ? (
                <span className="text-ink-soft">
                  <span className="text-accent-dark mr-1">▸ YOU</span>
                  {revealed}
                </span>
              ) : line.source === "system" ? (
                <span className="italic text-ink-soft">{revealed}</span>
              ) : (
                <span>
                  {revealed}
                  {isCurrentStreaming && isStreamingActive && (
                    <span className="ml-0.5 inline-block animate-pulse text-accent-dark">
                      ▍
                    </span>
                  )}
                </span>
              )}
              {done && !isStreamingActive && dialog.queue.length > 1 && (
                <span className="ml-2 inline-block animate-pulse text-accent-dark">
                  ▼
                </span>
              )}
            </>
          ) : dialog.isThinking ? (
            <div className="flex items-center justify-between gap-4">
              <span className="italic text-ink-soft">
                <LoadingDots /> thinking
              </span>
              <button
                onClick={cancelInFlight}
                className="pixel-font text-[9px] px-2 py-1 rounded border-2 border-ink bg-paper-dim hover:bg-white text-ink tracking-wide"
              >
                [CANCEL]
              </button>
            </div>
          ) : dialog.awaitingInput ? (
            <div className="flex gap-2 items-stretch">
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleInputKey}
                maxLength={300}
                placeholder="Type your message, then press Enter..."
                className="flex-1 bg-paper-dim border-2 border-ink rounded px-3 py-2 text-[14px] outline-none focus:bg-white"
              />
              <button onClick={sendMessage} className="btn btn-primary">
                SEND
              </button>
            </div>
          ) : null}
        </div>
        )}

        {syncMode && (
          <div className="flex gap-2 items-stretch mt-3">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleInputKey}
              maxLength={2000}
              placeholder={
                termAlive
                  ? "Message the agent — goes straight into the PTY..."
                  : "Terminal ended — cannot send."
              }
              disabled={!termAlive}
              className="flex-1 bg-paper-dim border-2 border-ink rounded px-3 py-2 text-[14px] outline-none focus:bg-white disabled:opacity-50"
            />
            <button
              onClick={sendMessage}
              disabled={!termAlive}
              className="btn btn-primary disabled:opacity-50"
            >
              SEND
            </button>
          </div>
        )}

        <div className="flex justify-between items-center mt-4 pt-3 border-t-2 border-ink">
          <div className="pixel-font text-[9px] text-ink-soft tracking-wide">
            {line
              ? isCurrentStreaming && isStreamingActive
                ? "STREAMING ▍"
                : done
                  ? dialog.queue.length > 1
                    ? "SPACE / ENTER ▸ CONTINUE"
                    : "SPACE / ENTER ▸ CONTINUE"
                  : "..."
              : dialog.isThinking
                ? "STANDBY"
                : "TYPE, ENTER TO SEND · ESC TO CLOSE"}
          </div>
          <button
            onClick={() => {
              cancelInFlight();
              closeDialog();
            }}
            className="pixel-font text-[9px] text-ink-soft hover:text-ink underline"
          >
            [CLOSE]
          </button>
        </div>
      </div>
    </div>
  );
}

function LoadingDots() {
  const [dots, setDots] = useState(".");
  useEffect(() => {
    const t = setInterval(() => {
      setDots((d) => (d.length >= 3 ? "." : d + "."));
    }, 400);
    return () => clearInterval(t);
  }, []);
  return <span>{dots}</span>;
}

function toolNameToState(toolName: string | undefined): AgentState {
  switch (toolName) {
    case "Read":
      return "reading_file";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "coding";
    case "Bash":
      return "calling_tool";
    case "Grep":
    case "Glob":
    case "WebFetch":
    case "WebSearch":
      return "searching";
    case "Task":
      return "thinking";
    case "TodoWrite":
      return "planning";
    default:
      return "thinking";
  }
}

// `getStr`, `shortPath`, `buildToolMessage` extracted to src/components/tool-format.ts
// so LiveThread / ActivityModal / AgentRoster can reuse the same formatters.

function splitIntoPages(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const pages: string[] = [];
  const words = text.split(/\s+/);
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxLen) {
      pages.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) pages.push(cur);
  return pages;
}
