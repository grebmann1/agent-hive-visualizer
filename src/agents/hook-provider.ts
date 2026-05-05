// Real-time hook-driven provider.
//
// Replaces the transcript-polling pipeline. Subscribes to
// `window.agentquest.subscribeHookEvents`, which the Electron main
// forwards from a local HTTP server listening on 127.0.0.1. Each hook
// payload is a raw Claude Code hook (PreToolUse, PostToolUse, Stop,
// etc.) — we map it into our generic `AgentEvent` shape and push to the
// store via the standard provider API.
//
// Identity: when the hook fires inside an AgentQuest embedded terminal,
// the wrapper script tags the payload with `agentquest_terminal_id`. For
// everything else we key by `session_id`. Either way the resulting agent
// id is stable for the lifetime of that claude session.
//
// Presence: hooks don't guarantee a clean "session ended" in every exit
// path, so we idle-timeout agents after ~10 min of silence.

import type { AgentEvent } from "../events/types";
import type {
  AgentProvider,
  AgentProviderAPI,
  AskEvent,
  AskHandle,
} from "./provider";

// --- Bridge typing -------------------------------------------------------
//
// The preload script (electron/preload.js) exposes `window.agentquest` with
// the subset of Electron/Node functionality the renderer needs. This type
// lives here because HookProvider is the canonical consumer of the bridge;
// other modules just import the global `Window.agentquest` it declares.

interface AgentQuestTerminalBridge {
  spawn: (opts: {
    terminalId: string;
    cwd?: string;
    shell?: string;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
  }) => Promise<{
    terminalId?: string;
    pid?: number;
    cwd?: string;
    error?: string;
  }>;
  write: (terminalId: string, data: string) => Promise<unknown>;
  resize: (terminalId: string, cols: number, rows: number) => Promise<unknown>;
  kill: (terminalId: string) => Promise<unknown>;
  onData: (
    cb: (p: { terminalId: string; data: string }) => void,
  ) => () => void;
  onExit: (
    cb: (p: { terminalId: string; exitCode: number; signal?: string }) => void,
  ) => () => void;
}

interface AgentQuestBridge {
  isElectron: boolean;
  platform: string;
  subscribeHookEvents: (cb: (payload: HookPayload) => void) => () => void;
  askClaude?: (
    args: { cwd: string; prompt: string },
    onEvent: (event: {
      type: "text" | "tool_use" | "done" | "error";
      delta?: string;
      toolName?: string;
      input?: unknown;
      fullText?: string;
      message?: string;
    }) => void,
  ) => { cancel: () => void; dispose: () => void };
  terminal?: AgentQuestTerminalBridge;
  pickDirectory?: () => Promise<{ canceled: boolean; path: string | null }>;
  focusExternalHost?: (
    pid: number,
  ) => Promise<{
    ok: boolean;
    app?: string;
    reason?: string;
    message?: string;
  }>;
  hooks?: {
    port: () => Promise<{ port: number | null }>;
    install: () => Promise<{
      ok?: boolean;
      error?: string;
      scriptPath?: string;
      settingsPath?: string;
    }>;
    uninstall: () => Promise<{ ok?: boolean; error?: string }>;
    isInstalled: () => Promise<{ installed: boolean; error?: string }>;
    openSettings: () => Promise<{ ok?: boolean; error?: string }>;
  };
}

declare global {
  interface Window {
    agentquest?: AgentQuestBridge;
  }
}

// Hook payload as received over IPC. Claude's own keys are snake_case;
// we pass them straight through without normalization.
export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string;
  stop_hook_active?: boolean;
  transcript_path?: string;
  model?: string;
  // Injected by the wrapper script when running inside an embedded terminal.
  agentquest_terminal_id?: string;
  // Free-form passthrough for anything else the hook adds.
  [key: string]: unknown;
}

interface AgentPresence {
  sessionId: string;
  cwd?: string;
  model?: string;
  terminalId?: string;
  external: boolean;
  lastSeen: number;
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const PRESENCE_SWEEP_MS = 30 * 1000;

function agentIdFor(payload: HookPayload): string | null {
  if (payload.agentquest_terminal_id) {
    return `term:${payload.agentquest_terminal_id}`;
  }
  if (payload.session_id) {
    // Session ids are UUIDs; slice to 12 chars for readability in the UI.
    return `session:${payload.session_id.slice(0, 12)}`;
  }
  return null;
}

function prettyName(agentId: string, sessionId?: string): string {
  if (agentId.startsWith("term:")) {
    const suffix = agentId.slice(-4);
    return `Claude-${suffix}`;
  }
  if (sessionId) {
    return `Claude-${sessionId.slice(0, 4)}`;
  }
  return agentId;
}

// Map hook tool_name → coarse AgentState used by behaviors / stateToRoom.
function toolToState(toolName: string | undefined):
  | "reading_file"
  | "coding"
  | "calling_tool"
  | "searching"
  | "thinking"
  | "planning" {
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
    case "TodoWrite":
      return "planning";
    default:
      return "thinking";
  }
}

// Read a string field from an unknown object (best-effort; used on tool inputs).
function pickString(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

// Claude's tool_response shape is tool-dependent. For our purposes, we
// only need a short human-readable blurb — if the response has a
// `content` array of text blocks, stitch them; if it has an `output` or
// `stdout` field, use that; otherwise stringify.
function summarizeToolResponse(resp: unknown): string {
  if (resp == null) return "";
  if (typeof resp === "string") return resp;
  if (typeof resp !== "object") return String(resp);
  const obj = resp as Record<string, unknown>;
  // Array of {type, text} blocks.
  if (Array.isArray(obj.content)) {
    const texts: string[] = [];
    for (const c of obj.content as Array<Record<string, unknown>>) {
      if (typeof c?.text === "string") texts.push(c.text);
    }
    if (texts.length) return texts.join("\n");
  }
  if (typeof obj.output === "string") return obj.output;
  if (typeof obj.stdout === "string") return obj.stdout;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.message === "string") return obj.message;
  try {
    return JSON.stringify(obj).slice(0, 400);
  } catch {
    return "";
  }
}

function isToolError(resp: unknown): boolean {
  if (resp && typeof resp === "object") {
    const obj = resp as Record<string, unknown>;
    if (obj.is_error === true) return true;
    if (obj.isError === true) return true;
  }
  return false;
}

export class HookProvider implements AgentProvider {
  readonly name = "claude-hook";

  private presence = new Map<string, AgentPresence>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private apiRef: AgentProviderAPI | null = null;
  // Active `claude -p` subprocesses keyed by agent id, for ask() routing.
  private pendingAsks = new Map<string, AskHandle>();

  start(api: AgentProviderAPI): () => void {
    this.apiRef = api;
    const bridge =
      typeof window !== "undefined" ? window.agentquest : undefined;
    const subscribe = bridge?.subscribeHookEvents;
    if (!subscribe) {
      // Outside Electron (SSR / browser preview). No-op.
      return () => {};
    }
    const unsubscribe = subscribe((payload: HookPayload) =>
      this.handle(payload, api),
    );
    this.sweepTimer = setInterval(
      () => this.sweepIdle(api),
      PRESENCE_SWEEP_MS,
    );
    return () => {
      unsubscribe();
      if (this.sweepTimer) clearInterval(this.sweepTimer);
      this.sweepTimer = null;
      this.apiRef = null;
      this.presence.clear();
      this.pendingAsks.forEach((h) => {
        try {
          h.cancel();
          h.dispose();
        } catch {
          /* ignore */
        }
      });
      this.pendingAsks.clear();
    };
  }

  /**
   * Chat entrypoint — streams `claude -p` output back to the dialog box.
   * Called by the registry's ask() method via `askViaProvider` discovery.
   * Requires a cwd — we read it from presence (populated on the first hook
   * event for this agent). Returns undefined if the agent is unknown or
   * the Electron bridge isn't available.
   */
  askViaProvider(
    agentId: string,
    prompt: string,
    onEvent: (e: AskEvent) => void,
  ): AskHandle | undefined {
    const bridge =
      typeof window !== "undefined" ? window.agentquest : undefined;
    if (!bridge || !bridge.askClaude) return undefined;
    const cwd = this.presence.get(agentId)?.cwd;
    if (!cwd) return undefined;
    const handle = bridge.askClaude({ cwd, prompt }, (ev) => {
      onEvent(ev as AskEvent);
    });
    this.pendingAsks.set(agentId, handle);
    return {
      cancel: () => {
        try {
          handle.cancel();
        } catch {
          /* ignore */
        }
      },
      dispose: () => {
        try {
          handle.dispose();
        } catch {
          /* ignore */
        }
        this.pendingAsks.delete(agentId);
      },
    };
  }

  private handle(payload: HookPayload, api: AgentProviderAPI): void {
    const agentId = agentIdFor(payload);
    if (!agentId) return;

    // Update presence + ensure the agent exists before emitting events.
    const now = Date.now();
    const existing = this.presence.get(agentId);
    const external = !payload.agentquest_terminal_id;
    const presence: AgentPresence = {
      sessionId: payload.session_id ?? existing?.sessionId ?? "",
      cwd: payload.cwd ?? existing?.cwd,
      model: payload.model ?? existing?.model,
      terminalId: payload.agentquest_terminal_id ?? existing?.terminalId,
      external,
      lastSeen: now,
    };
    this.presence.set(agentId, presence);
    if (!existing) {
      api.upsertAgent({
        id: agentId,
        displayName: prettyName(agentId, presence.sessionId),
        providerName: this.name,
        cwd: presence.cwd,
        metadata: {
          sessionId: presence.sessionId,
          terminalId: presence.terminalId,
          external,
          model: presence.model,
        },
      });
    }

    const timestamp = new Date(now).toISOString();
    const event = payload.hook_event_name;

    switch (event) {
      case "SessionStart":
        api.emitEvent({
          type: "agent.session",
          agentId,
          message: `Session ${presence.sessionId.slice(0, 8)} · ${payload.model ?? "claude"}`,
          timestamp,
          metadata: {
            sessionId: presence.sessionId,
            model: payload.model,
            cwd: payload.cwd,
          },
        });
        return;

      case "SessionEnd":
        api.removeAgent(agentId);
        this.presence.delete(agentId);
        return;

      case "UserPromptSubmit":
        // Visual: user just talked to the agent. Stash as a thinking event
        // so the roster & activity log show "User asked: ..." briefly.
        api.emitEvent({
          type: "agent.thinking",
          agentId,
          state: "thinking",
          message:
            typeof payload.prompt === "string" && payload.prompt.length > 0
              ? `You asked: ${payload.prompt.slice(0, 120)}`
              : "User asked something",
          timestamp,
          metadata: {
            text:
              typeof payload.prompt === "string" ? payload.prompt : undefined,
          },
        });
        return;

      case "PreToolUse": {
        const state = toolToState(payload.tool_name);
        const file =
          pickString(payload.tool_input, "file_path") ??
          pickString(payload.tool_input, "notebook_path") ??
          pickString(payload.tool_input, "command") ??
          pickString(payload.tool_input, "pattern") ??
          pickString(payload.tool_input, "url") ??
          pickString(payload.tool_input, "query");
        api.emitEvent({
          type: "agent.state.changed",
          agentId,
          state,
          message: payload.tool_name
            ? `${payload.tool_name}${file ? `: ${file.slice(0, 80)}` : ""}`
            : "",
          timestamp,
          metadata: {
            toolName: payload.tool_name,
            input: payload.tool_input,
          },
        });
        return;
      }

      case "PostToolUse":
      case "PostToolUseFailure": {
        const isError =
          event === "PostToolUseFailure" || isToolError(payload.tool_response);
        const resultText = summarizeToolResponse(payload.tool_response);
        api.emitEvent({
          type: "agent.tool.result",
          agentId,
          state: isError ? "failed" : "completed",
          message: isError
            ? `Error: ${resultText.slice(0, 200) || "tool failed"}`
            : resultText
              ? `OK: ${resultText.slice(0, 200)}`
              : "Tool finished.",
          timestamp,
          metadata: {
            toolName: payload.tool_name,
            isError,
            resultText,
          },
        });
        return;
      }

      case "Stop": {
        // Claude finished a turn. The hook payload doesn't reliably include
        // the final assistant text, but it signals turn-end so we surface
        // a short speech line. If a UserPromptSubmit came in earlier this
        // session, we assume the Stop is the response to it.
        api.emitEvent({
          type: "agent.state.changed",
          agentId,
          state: "summarizing",
          message: "(turn complete)",
          timestamp,
          metadata: {},
        });
        return;
      }

      default:
        // Unknown hook event — keep the presence update but don't emit.
        return;
    }
  }

  private sweepIdle(api: AgentProviderAPI): void {
    const now = Date.now();
    for (const [agentId, presence] of this.presence) {
      if (now - presence.lastSeen > IDLE_TIMEOUT_MS) {
        api.removeAgent(agentId);
        this.presence.delete(agentId);
      }
    }
  }

  /**
   * Test helper — returns the current presence snapshot. Used by the
   * LiveStatusChip popover to show "N live agents".
   */
  getPresence(): AgentPresence[] {
    return Array.from(this.presence.values());
  }
}

// Simple AgentEvent cast so the renderer types compile without importing
// the full union into this file.
export type { AgentEvent };
