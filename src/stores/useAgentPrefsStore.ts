"use client";

// Per-agent user preferences — display name + pinned flag.
//
// The roster needs identity that survives a session restart, but live
// agent ids are scoped to a process (terminal id or session_id). We
// key prefs by a stable composite (`cwd|pid` for terminal-linked
// agents, `cwd` alone for external ones) so re-running `claude` in
// the same project keeps the user's chosen name and pin position.
//
// Storage is plain localStorage; the prefs map is small (one entry
// per project the user has opened). No quotas, no schema migration —
// shape is just `{ name?: string; pinned?: boolean }`.

import { create } from "zustand";

const STORAGE_KEY = "agentquest:agent-prefs:v1";

export interface AgentPref {
  name?: string;
  pinned?: boolean;
}

interface AgentPrefsState {
  /** Composite key → pref. */
  prefs: Record<string, AgentPref>;
  /** Compute the stable key from an NPC's cwd + pid. Returns null
   *  when there's nothing stable to key on (anonymous in-process
   *  session); callers fall back to using the live id. */
  keyFor: (cwd: string | undefined, pid: number | undefined) => string | null;
  /** Read a pref by composite key. */
  get: (key: string) => AgentPref | undefined;
  /** Set the user-chosen name. Pass empty string to clear. */
  setName: (key: string, name: string) => void;
  /** Toggle pin state. */
  setPinned: (key: string, pinned: boolean) => void;
}

function loadPrefs(): Record<string, AgentPref> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, AgentPref>;
    }
  } catch {
    // ignore
  }
  return {};
}

function persist(prefs: Record<string, AgentPref>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore (private browsing, quota, etc)
  }
}

export const useAgentPrefsStore = create<AgentPrefsState>((set, get) => ({
  prefs: loadPrefs(),

  keyFor(cwd, pid) {
    if (!cwd) return null;
    return pid ? `${cwd}|${pid}` : cwd;
  },

  get(key) {
    return get().prefs[key];
  },

  setName(key, name) {
    set((s) => {
      const trimmed = name.trim();
      const existing = s.prefs[key] ?? {};
      const next: AgentPref = { ...existing };
      if (trimmed.length === 0) {
        delete next.name;
      } else {
        next.name = trimmed;
      }
      const nextPrefs = { ...s.prefs, [key]: next };
      // Drop empty entries to keep storage tidy.
      if (!next.name && !next.pinned) {
        delete nextPrefs[key];
      }
      persist(nextPrefs);
      return { prefs: nextPrefs };
    });
  },

  setPinned(key, pinned) {
    set((s) => {
      const existing = s.prefs[key] ?? {};
      const next: AgentPref = { ...existing, pinned };
      const nextPrefs = { ...s.prefs, [key]: next };
      if (!next.name && !next.pinned) {
        delete nextPrefs[key];
      }
      persist(nextPrefs);
      return { prefs: nextPrefs };
    });
  },
}));
