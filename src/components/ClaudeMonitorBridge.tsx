"use client";

// Thin bootstrap component — registers all agent providers and starts them
// on mount. Legacy filename retained so imports don't break. The real
// logic now lives in src/agents/*.
//
// To plug a new agent source, add your provider to the list below (or via
// registerProvider elsewhere at app boot).

import { useEffect } from "react";
import { HookProvider } from "../agents/hook-provider";
import { CursorProvider } from "../agents/cursor-provider";
import {
  registerProvider,
  startAllProviders,
  stopAllProviders,
} from "../agents/registry";
import type { AskHandle } from "../agents/provider";
import { useNpcStore } from "../stores/useNpcStore";
import { wireTerminalNpcCrossRef } from "../stores/useTerminalStore";

// Legacy type re-exports so DialogBox.tsx et al. keep compiling.
export type AskClaudeHandle = AskHandle;
export interface AskClaudeStreamEvent {
  type: "text" | "tool_use" | "done" | "error";
  delta?: string;
  toolName?: string;
  input?: unknown;
  fullText?: string;
  message?: string;
}

// Register providers once (module-level guard — React strict mode would
// otherwise double-register and double-start them).
let registered = false;
function ensureRegistered() {
  if (registered) return;
  registered = true;
  // Hook-based real-time provider — the only provider now that the
  // transcript-watcher pipeline has been retired. To add a new source,
  // implement AgentProvider and register here.
  registerProvider(new HookProvider());

  // Cursor provider — opt-in skeleton (no-op until the Cursor IPC is
  // wired). Behind a feature flag so the default app continues to
  // surface only Claude sessions.
  if (process.env.NEXT_PUBLIC_ENABLE_CURSOR_PROVIDER === "true") {
    registerProvider(new CursorProvider());
  }
}

export default function ClaudeMonitorBridge() {
  useEffect(() => {
    ensureRegistered();
    startAllProviders();
    // Link dynamic NPCs that carry a terminalId back to their terminal
    // tab so clicking either side focuses the other.
    const unsubCrossRef = wireTerminalNpcCrossRef(
      (cb) => useNpcStore.subscribe(cb),
      () => useNpcStore.getState().dynamic,
    );
    return () => {
      unsubCrossRef();
      stopAllProviders();
    };
  }, []);
  return null;
}
