import { create } from "zustand";
import type { NpcDef } from "../game/npcs";

export type DialogSource = "system" | "npc" | "player";

export interface DialogLine {
  id: string;
  source: DialogSource;
  speaker?: string; // NPC name
  text: string;
}

export interface DialogState {
  active: boolean;
  // current NPC player is talking to (null = no conversation)
  npcId: string | null;
  // queue of lines currently being delivered (the visible "page" may be 1-2 lines)
  queue: DialogLine[];
  // whether the player can type a response
  awaitingInput: boolean;
  // whether the NPC is currently "thinking" / Claude call in flight
  isThinking: boolean;
  // id of a line that's currently streaming in (text mutates as deltas arrive)
  // — the typewriter effect in DialogBox disables for this id and just shows text.
  streamingLineId: string | null;
  // Last tool_use seen during a streaming response (e.g. "Reading src/foo.ts")
  // Shown as a subtle status line inside the dialog box; null when idle.
  toolStatus: string | null;
}

export interface DialogTurn {
  role: "user" | "assistant";
  content: string;
}

interface GameStoreState {
  // When set, WorldScene's camera centers on this NPC each frame. Manual
  // pan (wheel/drag) clears it. Driven by the ContextMenu's Follow item.
  followNpcId: string | null;

  // Dialog box state
  dialog: DialogState;

  // Persisted chat history per NPC — restored when the user reopens
  // the dialog for the same agent. Bounded to ~20 turns to keep the
  // store light.
  dialogHistoryByNpc: Record<string, DialogTurn[]>;

  // actions
  setFollowNpc: (id: string | null) => void;

  openDialog: (npc: NpcDef, greetingOverride?: string) => void;
  closeDialog: () => void;
  // Returns the newly-created line's id so callers can track it (e.g. streaming).
  enqueueLine: (line: Omit<DialogLine, "id">) => string;
  shiftLine: () => void;
  setAwaitingInput: (v: boolean) => void;
  setThinking: (v: boolean) => void;

  // Streaming helpers used by the LIVE claude -p dialog path.
  startStreamingLine: (line: Omit<DialogLine, "id">) => string;
  appendToStreamingLine: (text: string) => void;
  finishStreamingLine: () => void;
  setToolStatus: (s: string | null) => void;

  // Append a turn to a specific agent's dialog history.
  appendDialogTurn: (npcId: string, turn: DialogTurn) => void;
}

let lineCounter = 0;

export const useGameStore = create<GameStoreState>()((set) => ({
  followNpcId: null,
  dialogHistoryByNpc: {},

  dialog: {
    active: false,
    npcId: null,
    queue: [],
    awaitingInput: false,
    isThinking: false,
    streamingLineId: null,
    toolStatus: null,
  },

  setFollowNpc: (id) => set({ followNpcId: id }),

  openDialog: (npc, greetingOverride) =>
    set({
      dialog: {
        active: true,
        npcId: npc.id,
        queue: [
          {
            id: `line-${++lineCounter}`,
            source: "npc",
            speaker: npc.name,
            text: greetingOverride ?? npc.greeting,
          },
        ],
        awaitingInput: false,
        isThinking: false,
        streamingLineId: null,
        toolStatus: null,
      },
    }),

  closeDialog: () =>
    set({
      dialog: {
        active: false,
        npcId: null,
        queue: [],
        awaitingInput: false,
        isThinking: false,
        streamingLineId: null,
        toolStatus: null,
      },
    }),

  enqueueLine: (line) => {
    const id = `line-${++lineCounter}`;
    set((s) => ({
      dialog: {
        ...s.dialog,
        queue: [...s.dialog.queue, { id, ...line }],
      },
    }));
    return id;
  },

  shiftLine: () =>
    set((s) => {
      const [, ...rest] = s.dialog.queue;
      return { dialog: { ...s.dialog, queue: rest } };
    }),

  setAwaitingInput: (v) =>
    set((s) => ({ dialog: { ...s.dialog, awaitingInput: v } })),

  setThinking: (v) => set((s) => ({ dialog: { ...s.dialog, isThinking: v } })),

  startStreamingLine: (line) => {
    const id = `line-${++lineCounter}`;
    set((s) => ({
      dialog: {
        ...s.dialog,
        queue: [...s.dialog.queue, { id, ...line }],
        streamingLineId: id,
      },
    }));
    return id;
  },

  appendToStreamingLine: (text) =>
    set((s) => {
      const id = s.dialog.streamingLineId;
      if (!id) return s;
      return {
        dialog: {
          ...s.dialog,
          queue: s.dialog.queue.map((l) =>
            l.id === id ? { ...l, text: l.text + text } : l,
          ),
        },
      };
    }),

  finishStreamingLine: () =>
    set((s) => ({
      dialog: { ...s.dialog, streamingLineId: null, toolStatus: null },
    })),

  setToolStatus: (v) =>
    set((s) => ({ dialog: { ...s.dialog, toolStatus: v } })),

  appendDialogTurn: (npcId, turn) =>
    set((s) => {
      const HISTORY_CAP = 20;
      const prev = s.dialogHistoryByNpc[npcId] ?? [];
      const next = [...prev, turn];
      if (next.length > HISTORY_CAP) next.splice(0, next.length - HISTORY_CAP);
      return {
        dialogHistoryByNpc: { ...s.dialogHistoryByNpc, [npcId]: next },
      };
    }),
}));
