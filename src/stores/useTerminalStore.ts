// In-renderer state for the embedded-terminal panel.
//
// Each `terminal` represents one PTY-backed shell running in the Electron
// main process (see electron/pty-host.js). The store owns the lifecycle:
// openTerminal() tells main to spawn, closeTerminal() tells it to kill.
// The actual xterm.js instance is owned by the TerminalInstance component;
// this store is just a bookkeeping ledger so other components (the roster,
// Orin's dialog, the +New Agent modal) can cross-reference tabs and NPCs.

import { create } from "zustand";

// Window.agentquest.* is declared in src/agents/hook-provider.ts —
// we rely on that global module augmentation rather than shadowing it here.

export interface TerminalEntry {
  id: string;
  // Human label for the tab strip. Defaults to basename(cwd).
  title: string;
  cwd: string;
  shell?: string;
  createdAt: number;
  // If the claude monitor has observed a claude PID spawned inside this
  // terminal, this gets populated (cross-ref into useNpcStore.dynamic[id]).
  npcId?: string;
  // Pid of the shell itself (from main/pty-host).
  shellPid?: number;
  // `false` once `terminal:exit` has arrived — the UI can strike through
  // the tab title instead of just yanking it.
  alive: boolean;
}

interface TerminalStoreState {
  terminals: Record<string, TerminalEntry>;
  order: string[]; // tab order
  activeTerminalId: string | null;
  splitOpen: boolean;

  openTerminal: (opts: {
    cwd?: string;
    shell?: string;
    title?: string;
  }) => Promise<string | null>;
  closeTerminal: (terminalId: string) => Promise<void>;
  setActive: (terminalId: string | null) => void;
  toggleSplit: () => void;
  setSplitOpen: (v: boolean) => void;
  linkNpc: (terminalId: string, npcId: string) => void;
  markExited: (terminalId: string) => void;
}

let counter = 0;
function newTerminalId(): string {
  counter += 1;
  return `term-${Date.now().toString(36)}-${counter}`;
}

function titleFromCwd(cwd: string | undefined): string {
  if (!cwd) return "shell";
  return cwd.split("/").filter(Boolean).pop() ?? "shell";
}

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  terminals: {},
  order: [],
  activeTerminalId: null,
  splitOpen: false,

  async openTerminal(opts) {
    const bridge =
      typeof window !== "undefined" ? window.agentquest?.terminal : undefined;
    if (!bridge) return null;
    const id = newTerminalId();
    const cwd = opts.cwd || "";
    const title = opts.title || titleFromCwd(cwd);
    const res = await bridge.spawn({ terminalId: id, cwd: cwd || undefined, shell: opts.shell });
    if (res && "error" in res && res.error) {
      console.error("[agentquest] terminal spawn failed:", res.error);
      return null;
    }
    set((s) => ({
      terminals: {
        ...s.terminals,
        [id]: {
          id,
          title,
          cwd: (res?.cwd as string) || cwd,
          shell: opts.shell,
          createdAt: Date.now(),
          shellPid: res?.pid,
          alive: true,
        },
      },
      order: [...s.order, id],
      activeTerminalId: id,
      splitOpen: true,
    }));
    return id;
  },

  async closeTerminal(terminalId) {
    const bridge =
      typeof window !== "undefined" ? window.agentquest?.terminal : undefined;
    if (bridge) {
      try {
        await bridge.kill(terminalId);
      } catch {
        // ignore
      }
    }
    set((s) => {
      const { [terminalId]: _gone, ...rest } = s.terminals;
      const order = s.order.filter((t) => t !== terminalId);
      const active =
        s.activeTerminalId === terminalId
          ? order[order.length - 1] ?? null
          : s.activeTerminalId;
      return {
        terminals: rest,
        order,
        activeTerminalId: active,
      };
    });
  },

  setActive(terminalId) {
    set({ activeTerminalId: terminalId });
  },

  toggleSplit() {
    set((s) => ({ splitOpen: !s.splitOpen }));
  },

  setSplitOpen(v) {
    set({ splitOpen: v });
  },

  linkNpc(terminalId, npcId) {
    const t = get().terminals[terminalId];
    if (!t) return;
    set((s) => ({
      terminals: {
        ...s.terminals,
        [terminalId]: { ...t, npcId },
      },
    }));
  },

  markExited(terminalId) {
    const t = get().terminals[terminalId];
    if (!t) return;
    set((s) => ({
      terminals: {
        ...s.terminals,
        [terminalId]: { ...t, alive: false },
      },
    }));
  },
}));

// Cross-ref hook: whenever a dynamic NPC arrives with a terminalId, link it
// both directions. Must be imported from a client-side boot path so the
// subscription lives as long as the renderer.
export function wireTerminalNpcCrossRef(
  subscribeNpcs: (cb: () => void) => () => void,
  getDynamic: () => Record<string, { id: string; terminalId?: string }>,
) {
  const seen = new Set<string>();
  const apply = () => {
    const dyn = getDynamic();
    for (const npc of Object.values(dyn)) {
      if (!npc.terminalId) continue;
      if (seen.has(npc.id)) continue;
      seen.add(npc.id);
      useTerminalStore.getState().linkNpc(npc.terminalId, npc.id);
    }
  };
  apply();
  return subscribeNpcs(apply);
}
