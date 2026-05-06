// zones.ts — building layout for the LimeZu pipeline.
//
// The map is authored externally (you provide `src/game/map.json`).
// Two layers per cell:
//   - `floor`  — base layer (floor or wall slice, or null for exterior grass)
//   - `decor`  — optional furniture above the floor (null if none)
//
// Walkability:
//   - Floor cells whose slice comes from the LimeZu walls atlas (`rb_walls`)
//     block movement. Everything else on floor is walkable.
//   - Any non-null decor cell blocks movement.
// We don't try to be cleverer than this — if your map.json wants a
// walkable rug or counter, just leave the decor cell null on top of it.
//
// Anchors map RoomIds to specific cells; NPC behaviors walk agents to
// these. Override per-map by adding an "anchors" object to map.json.

import type { RoomId } from "../events/types";
import type { AtlasSlice } from "./atlas";
import savedMapRaw from "./map.json";

interface SavedMap {
  cols: number;
  rows: number;
  tileSize: number;
  floor: (AtlasSlice | null)[][];
  decor: (AtlasSlice | null)[][];
  // Optional — override anchors. Falls back to DEFAULT_ANCHORS otherwise.
  anchors?: Partial<Record<RoomId, { col: number; row: number }>>;
}
const savedMap = savedMapRaw as unknown as SavedMap;

export type ZoneId = "interior";

export interface ZoneDef {
  id: ZoneId;
  name: string;
  cols: number;
  rows: number;
  floor: (AtlasSlice | null)[][];
  decor: (AtlasSlice | null)[][];
  anchors: Partial<Record<RoomId, { col: number; row: number }>>;
}

const COLS = savedMap.cols ?? 32;
const ROWS = savedMap.rows ?? 22;

// If map.json is the empty stub (floor=[]) we still want a valid
// 32×22 grid so the renderer doesn't crash. Pad with nulls.
function padLayer(
  layer: (AtlasSlice | null)[][] | undefined,
): (AtlasSlice | null)[][] {
  const out: (AtlasSlice | null)[][] = [];
  for (let r = 0; r < ROWS; r++) {
    const src = (layer && layer[r]) || [];
    const row: (AtlasSlice | null)[] = new Array(COLS).fill(null);
    for (let c = 0; c < COLS; c++) {
      const cell = src[c];
      if (cell) row[c] = cell;
    }
    out.push(row);
  }
  return out;
}

const FLOOR = padLayer(savedMap.floor);
const DECOR = padLayer(savedMap.decor);

// Default anchors — center-ish cells inside each room. These get used
// when map.json doesn't ship its own. Overridable per-map.
const DEFAULT_ANCHORS: Partial<Record<RoomId, { col: number; row: number }>> = {
  library:       { col: 5,  row: 6  },
  coding_room:   { col: 11, row: 6  },
  desk:          { col: 17, row: 6  },
  cinema:        { col: 25, row: 6  },
  tool_workshop: { col: 5,  row: 16 },
  meeting_room:  { col: 11, row: 16 },
  testing_lab:   { col: 17, row: 16 },
};

const ANCHORS = savedMap.anchors ?? DEFAULT_ANCHORS;

// South-edge entry/exit. Used by walk-in / walk-out. Defaults to col 16
// at the bottom edge of the map; if your front door is elsewhere, set
// `EXTERIOR_ANCHORS` via map.json (future) or leave it.
export const EXTERIOR_ANCHORS = {
  entry: { col: 16, row: ROWS - 1 },
  exit: { col: 16, row: ROWS - 1 },
};

export const INTERIOR_ZONE: ZoneDef = {
  id: "interior",
  name: "Agent Ops",
  cols: COLS,
  rows: ROWS,
  floor: FLOOR,
  decor: DECOR,
  anchors: ANCHORS,
};

export const ZONES: Record<ZoneId, ZoneDef> = {
  interior: INTERIOR_ZONE,
};

// =============================================================================
// Walkability
// =============================================================================
//
// Floor slices from `rb_walls` block movement. Decor cells of any slice
// also block. Everything else is walkable. No hand-curated slice list —
// the wall atlas itself is the single source of truth for "this is a wall".

const WALL_ATLAS = "rb_walls";

export function isWalkableIn(zone: ZoneDef, col: number, row: number): boolean {
  if (col < 0 || col >= zone.cols || row < 0 || row >= zone.rows) return false;
  const f = zone.floor[row][col];
  if (f && f.atlas === WALL_ATLAS) return false;
  const d = zone.decor[row][col];
  if (d) return false;
  return true;
}
