import type { RoomId } from "../events/types";

export interface NpcDef {
  id: string;
  name: string;
  role: string;
  homeRoom: RoomId;
  // tile position within room (absolute grid coords)
  col: number;
  row: number;
  // palette tint — swap the classic GB light/lightest shades
  tint: { l?: string; L?: string; d?: string };
  // Kenney Tiny Dungeon character-tile index used as the sprite's base look.
  // Optional: defaults to tile 85 (the original farmer) if unset.
  baseTile?: number;
  // one-line intro shown when the player talks to them
  greeting: string;
  // system prompt for the real Claude API
  systemPrompt: string;
  // what this agent "does" — used by the action->visual bridge
  toolBox: string[];
}

// v2.0: AgentQuest is a pure observatory. The world shows live `claude`
// processes the monitor has detected — nothing else. No static built-in
// NPCs (the old Orin/dispatcher concept was removed). Live agents still
// come from `useNpcStore.ts::makeDynamicNpc` via the provider pipeline.
//
// This array is kept exported (empty) so `npcById` and every consumer that
// iterates `NPCS` still compiles as a no-op.
export const NPCS: NpcDef[] = [];

export function npcById(id: string): NpcDef | undefined {
  const fromStatic = NPCS.find((n) => n.id === id);
  if (fromStatic) return fromStatic;
  // Defer dynamic lookup to the store — import lazily to avoid cycles
  // (only runs client-side; API routes that need NpcDef call npcByIdFromAny).
  if (typeof window !== "undefined") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { useNpcStore } = require("../stores/useNpcStore") as typeof import("../stores/useNpcStore");
      return useNpcStore.getState().dynamic[id];
    } catch {
      return undefined;
    }
  }
  return undefined;
}
