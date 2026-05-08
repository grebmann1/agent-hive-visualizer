import { create } from "zustand";
import type { RoomId } from "../events/types";
import type { NpcDef } from "../game/npcs";
import { NPCS as STATIC_NPCS } from "../game/npcs";

export interface DynamicNpc extends NpcDef {
  // Distinguish from the built-in roster
  dynamic: true;
  // Attached process info (if this NPC was spawned from a claude CLI process)
  pid?: number;
  // Resolved working directory of the PID, if known. When present, the dialog
  // box will route messages through `claude -p` inside this directory instead
  // of the generic `/api/chat` endpoint.
  cwd?: string;
  // If this NPC was adopted as a sub-agent of another NPC at join time.
  // The scene spawns the sprite NEXT TO the parent (not at the default home
  // room anchor) and draws a tether between them.
  parentId?: string;
  // If this claude was launched inside one of AgentQuest's embedded terminals,
  // this ties the NPC back to the terminal tab that started it.
  terminalId?: string;
  // True when this NPC represents a claude session detected OUTSIDE AgentQuest
  // (e.g. started in iTerm, VS Code, or Cursor). Used by the roster to render
  // an "EXT" chip instead of "LIVE".
  external?: boolean;
}

type AnyNpc = NpcDef | DynamicNpc;

interface NpcStoreState {
  // Built-in static NPCs — always present
  staticNpcs: NpcDef[];
  // Dynamic NPCs keyed by id (e.g., `claude-12345`)
  dynamic: Record<string, DynamicNpc>;

  addDynamic: (npc: DynamicNpc) => void;
  removeDynamic: (id: string) => void;
  all: () => AnyNpc[];
}

export const useNpcStore = create<NpcStoreState>((set, get) => ({
  staticNpcs: STATIC_NPCS,
  dynamic: {},

  addDynamic: (npc) =>
    set((s) => ({ dynamic: { ...s.dynamic, [npc.id]: npc } })),

  removeDynamic: (id) =>
    set((s) => {
      const { [id]: _removed, ...rest } = s.dynamic;
      return { dynamic: rest };
    }),

  all: () => [...get().staticNpcs, ...Object.values(get().dynamic)],
}));

// Where to place a new dynamic NPC — rotate through the rooms
const ROOM_CYCLE: RoomId[] = [
  "desk",
  "coding_room",
  "library",
  "tool_workshop",
  "testing_lab",
  "meeting_room",
];

// Palette tints for dynamic NPCs — stable hash per id
const DYNAMIC_PALETTES: Array<{ l: string; L: string; d?: string }> = [
  { l: "#e63946", L: "#ff8f8f" }, // red
  { l: "#f5a623", L: "#ffd18e" }, // orange
  { l: "#4a90e2", L: "#a3c5ff" }, // blue
  { l: "#7b68ee", L: "#b8a5ff" }, // purple
  { l: "#2a9d8f", L: "#8ddccf" }, // teal
  { l: "#e6c229", L: "#ffe88a" }, // yellow
  { l: "#b5838d", L: "#e5c7ce" }, // mauve
  { l: "#8c6239", L: "#caa47a" }, // brown
];

// Kenney Tiny Dungeon character-tile indices used for dynamic NPCs. Each entry
// is a distinct humanoid silhouette so that two simultaneously-visible agents
// look different. Hashed by id in parallel with the palette above.
const DYNAMIC_BASE_TILES: number[] = [
  85, // farmer (blond, gray shirt)
  86, // monk (brown hair, orange shirt)
  87, // knight (gray armor)
  88, // orange-haired adventurer
  89, // hooded villager
  90, // cloaked ranger
  91, // bearded traveller
  92, // elder/mage
  97, // armored soldier
  98, // warrior (brown hair, gray shirt)
  99, // pale adventurer
  100, // gray-armored guard
  101, // masked rogue
  102, // caped sorceror
  108, // halfling scout
  109, // wayfarer in hood
  110, // squire
  111, // dwarf with helmet
  112, // robed acolyte
];

function hashId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function makeDynamicNpc(input: {
  id: string;
  name: string;
  pid?: number;
  cmd?: string;
  cwd?: string;
  parentId?: string;
  terminalId?: string;
  external?: boolean;
}): DynamicNpc {
  const h = hashId(input.id);
  const palette = DYNAMIC_PALETTES[h % DYNAMIC_PALETTES.length];
  // Use a different hash factor so tile and palette aren't perfectly correlated
  const baseTile =
    DYNAMIC_BASE_TILES[(h >> 5) % DYNAMIC_BASE_TILES.length];
  const room = ROOM_CYCLE[h % ROOM_CYCLE.length];
  // Read anchors live from rooms.ts — derived from named objects in
  // the .tmj. Lazy-loaded import dodges circular module initialization
  // (rooms.ts → zones.ts → ... → useNpcStore in some branches).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ROOM_ANCHORS } = require("../game/rooms") as typeof import("../game/rooms");
  const ANCHORS = (Object.keys({
    library: 0, coding_room: 0, desk: 0,
    tool_workshop: 0, meeting_room: 0, testing_lab: 0,
  }) as RoomId[]).reduce<Record<RoomId, { col: number; row: number }>>(
    (acc, id) => {
      const a = ROOM_ANCHORS[id];
      acc[id] = a ? { col: a.col, row: a.row } : { col: 24, row: 16 };
      return acc;
    },
    {} as Record<RoomId, { col: number; row: number }>,
  );
  const anchor = ANCHORS[room];

  // Small variation per hash so multiple NPCs don't stack
  const offsetCol = (h % 3) - 1;
  const offsetRow = ((h >> 3) % 3) - 1;

  // If this is a sub-agent (adopted by a parent via an open Task tool_use),
  // the scene places the sprite next to the parent at scene-layer time. We
  // still set a sensible home room here so pathfinding works after.
  return {
    dynamic: true,
    pid: input.pid,
    cwd: input.cwd,
    parentId: input.parentId,
    terminalId: input.terminalId,
    external: input.external,
    id: input.id,
    name: input.name,
    role: input.parentId ? "Sub-agent" : "Claude Agent",
    homeRoom: room,
    col: anchor.col + offsetCol,
    row: anchor.row + offsetRow,
    tint: palette,
    baseTile,
    greeting: buildGreeting(input.name, input.cmd, input.cwd),
    systemPrompt:
      "You are an NPC in a 2D game called Agent Force HQ — you represent an actual Claude CLI process " +
      "running on the user's laptop. You are friendly, concise (1-3 short sentences), and kid-friendly. " +
      "When asked what you're doing, make up something plausible for a Claude coding agent " +
      "(reading files, writing code, running tests). Never break character; never say you're an AI.",
    toolBox: ["read_file", "edit_file", "run_tests", "search"],
  };
}

function buildGreeting(name: string, cmd?: string, cwd?: string): string {
  const hints: string[] = [];
  if (cmd && /test/i.test(cmd)) hints.push("running tests");
  else if (cmd && /build/i.test(cmd)) hints.push("building");
  else if (cmd && /code/i.test(cmd)) hints.push("writing code");
  const suffix = hints.length ? ` I'm ${hints[0]} right now.` : "";
  const base = cwd?.split("/").filter(Boolean).pop();
  const where = base ? ` Working in ${base}.` : "";
  return `Hi! I'm ${name}, a Claude agent running on your laptop.${suffix}${where} What's up?`;
}

// Resolved at dialog-open time (not creation time) so the greeting reflects
// what the real Claude process is actually doing right now. Takes the NPC
// def + the current activity (from useAgentStore.activities[npc.id]).
// Falls back to the static greeting if no activity recorded.
export function buildLiveGreeting(
  npc: { name: string; cwd?: string; greeting: string; parentId?: string },
  activity?: { bubble?: string },
): string {
  const base = npc.cwd?.split("/").filter(Boolean).pop();
  const where = base ? ` Working in ${base}.` : "";

  if (activity?.bubble) {
    const bubble = activity.bubble.trim();
    // Lowercase the first letter so it flows naturally after "Currently ".
    const cur =
      bubble.length > 0
        ? bubble.charAt(0).toLowerCase() + bubble.slice(1)
        : "";
    const kind = npc.parentId ? "sub-agent" : "Claude agent";
    return `${npc.name} here — ${kind}. Currently ${cur}.${where} What's up?`;
  }

  // No recorded activity: fall back to the static creation-time greeting.
  return npc.greeting;
}
