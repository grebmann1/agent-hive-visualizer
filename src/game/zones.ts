// zones.ts — building layout for the LimeZu pipeline.
//
// The map is now authored in terms of AtlasSlice references rather than
// numeric tile IDs. Two layers per cell:
//   - `floor`  — base layer (floor or wall slice, always present)
//   - `decor`  — optional furniture above the floor (null if none)
// Walkability is derived from a "blocking" check on the slice: walls in
// the floor layer block; furniture in the decor layer blocks unless it's
// in the WALKABLE_DECOR set.
//
// Building plan (32 cols × 22 rows):
//
//   rows 0–2    : exterior grass band (north)
//   rows 3      : top wall
//   rows 4–9    : top-floor rooms (Library | Workshop | Control | Lounge)
//   row 10      : interior wall between top-row and corridor (with doors)
//   row 11      : corridor floor
//   row 12      : interior wall between corridor and bottom-row (with doors)
//   rows 13–18  : bottom-floor rooms (Kitchen | Meeting | Test Rig | Reception)
//   row 19      : bottom wall (with front-door gap at col 16)
//   rows 20–21  : exterior grass band (south)
//
// Top-row room columns:    Library 2-9, Workshop 10-13, Control 14-21, Lounge 22-29
// Bottom-row room columns: Kitchen 2-9, Meeting 10-13, TestRig 14-21, Reception 22-29
// (Workshop + Meeting are 4-col rooms; the other six rooms are 8-col.
//  Compromise to fit 32 cols total — the user can grow the map later.)

import type { RoomId } from "../events/types";
import savedMapRaw from "./map.json";

// Cast the JSON to a known shape so the inferred `never[]` from the empty
// floor array doesn't poison the rest of the file.
interface SavedMap {
  cols: number;
  rows: number;
  tileSize: number;
  floor: (AtlasSlice | null)[][];
  decor: (AtlasSlice | null)[][];
}
const savedMap = savedMapRaw as unknown as SavedMap;
import {
  BOOKSHELF_TALL,
  COFFEE_TABLE,
  COUCH_LEFT,
  COUCH_MID,
  COUCH_RIGHT,
  DESK_BOTTOM_GREY,
  DESK_BOTTOM_WOOD,
  DESK_TOP_GREY,
  DESK_TOP_WOOD,
  DOOR_OPEN,
  FILE_CABINET,
  FLOOR_CARPET_GOLD,
  FLOOR_OFFICE_GREY,
  FLOOR_TILE_TERRACOTTA,
  FLOOR_WOOD_DARK,
  FLOOR_WOOD_LIGHT,
  FRIDGE,
  KITCHEN_SINK,
  KITCHEN_TABLE,
  LAB_BENCH,
  LAB_MACHINE_TALL,
  MICROSCOPE,
  MONITOR_ON,
  OFFICE_PLANT_TALL,
  PRINTER,
  READING_TABLE,
  ROUND_TABLE,
  SERVER_RACK,
  STONE_PATH,
  STOVE,
  TV_STAND,
  WALL_BOTTOM,
  WALL_CORNER_BL,
  WALL_CORNER_BR,
  WALL_CORNER_TL,
  WALL_CORNER_TR,
  WALL_LEFT,
  WALL_RIGHT,
  WALL_T_NORTH,
  WALL_T_SOUTH,
  WALL_TOP,
} from "./limezu-tiles";
import type { AtlasSlice } from "./atlas";

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

const COLS = 32;
const ROWS = 22;

// Empty grid helper.
function grid<T>(filler: T): T[][] {
  return Array.from({ length: ROWS }, () => new Array(COLS).fill(filler));
}

// Per-region floor map. Cells outside any region are null (which the
// renderer treats as exterior grass — handled by drawMap with a flat green
// rectangle, since LimeZu Modern Interiors doesn't ship grass tiles).
type Region = {
  id: RoomId;
  colMin: number;
  colMax: number;
  rowMin: number;
  rowMax: number;
  floor: AtlasSlice;
};

const TOP_ROOMS: Region[] = [
  { id: "library",     colMin: 2,  colMax: 9,  rowMin: 4, rowMax: 9, floor: FLOOR_WOOD_LIGHT },
  { id: "coding_room", colMin: 10, colMax: 13, rowMin: 4, rowMax: 9, floor: FLOOR_WOOD_DARK },
  { id: "desk",        colMin: 14, colMax: 21, rowMin: 4, rowMax: 9, floor: FLOOR_OFFICE_GREY },
  { id: "cinema",      colMin: 22, colMax: 29, rowMin: 4, rowMax: 9, floor: FLOOR_WOOD_LIGHT },
];
const BOTTOM_ROOMS: Region[] = [
  { id: "tool_workshop", colMin: 2,  colMax: 9,  rowMin: 13, rowMax: 18, floor: FLOOR_TILE_TERRACOTTA },
  { id: "meeting_room",  colMin: 10, colMax: 13, rowMin: 13, rowMax: 18, floor: FLOOR_CARPET_GOLD },
  { id: "testing_lab",   colMin: 14, colMax: 21, rowMin: 13, rowMax: 18, floor: FLOOR_OFFICE_GREY },
  // Reception room — currently re-uses cinema's RoomId since we don't have
  // a "reception" RoomId. Keep it as a plain spare for now; pathfinding
  // works because the cells are walkable.
];
const ROOMS: Region[] = [...TOP_ROOMS, ...BOTTOM_ROOMS];

// Build the floor + wall layer.
const FLOOR: (AtlasSlice | null)[][] = grid<AtlasSlice | null>(null);
const DECOR: (AtlasSlice | null)[][] = grid<AtlasSlice | null>(null);

// Paint room floors.
for (const r of ROOMS) {
  for (let row = r.rowMin; row <= r.rowMax; row++) {
    for (let col = r.colMin; col <= r.colMax; col++) {
      FLOOR[row][col] = r.floor;
    }
  }
}

// Paint corridor (row 11) using neutral grey.
for (let col = 1; col < COLS - 1; col++) {
  FLOOR[11][col] = FLOOR_OFFICE_GREY;
}

// Building outer walls — top row 3, bottom row 19, sides cols 1 and COLS-2.
// Outer rows of the building are dedicated to wall tiles; interior rooms
// sit inside this perimeter.
const BUILDING_TOP_ROW = 3;
const BUILDING_BOT_ROW = 19;
const BUILDING_LEFT_COL = 1;
const BUILDING_RIGHT_COL = COLS - 2; // 30

// Top + bottom horizontal walls.
for (let col = BUILDING_LEFT_COL; col <= BUILDING_RIGHT_COL; col++) {
  FLOOR[BUILDING_TOP_ROW][col] = WALL_TOP;
  FLOOR[BUILDING_BOT_ROW][col] = WALL_BOTTOM;
}
// Side walls.
for (let row = BUILDING_TOP_ROW; row <= BUILDING_BOT_ROW; row++) {
  FLOOR[row][BUILDING_LEFT_COL] = WALL_LEFT;
  FLOOR[row][BUILDING_RIGHT_COL] = WALL_RIGHT;
}
// Corners.
FLOOR[BUILDING_TOP_ROW][BUILDING_LEFT_COL] = WALL_CORNER_TL;
FLOOR[BUILDING_TOP_ROW][BUILDING_RIGHT_COL] = WALL_CORNER_TR;
FLOOR[BUILDING_BOT_ROW][BUILDING_LEFT_COL] = WALL_CORNER_BL;
FLOOR[BUILDING_BOT_ROW][BUILDING_RIGHT_COL] = WALL_CORNER_BR;

// Front door — south wall at col 16, walkable gap.
const FRONT_DOOR_COL = 16;
FLOOR[BUILDING_BOT_ROW][FRONT_DOOR_COL] = DOOR_OPEN;

// Internal walls between rooms and corridor.
//   - Row 10 (between top rooms and corridor): wall body, with one door
//     per top room into the corridor.
//   - Row 12 (between corridor and bottom rooms): same.
//   - Vertical walls between adjacent rooms (top + bottom rows).
for (let col = BUILDING_LEFT_COL + 1; col < BUILDING_RIGHT_COL; col++) {
  FLOOR[10][col] = WALL_T_SOUTH;
  FLOOR[12][col] = WALL_T_NORTH;
}

// Doors from top rooms → corridor (at the centerish col of each room).
const TOP_DOOR_COLS = [5, 11, 17, 25];
for (const c of TOP_DOOR_COLS) FLOOR[10][c] = DOOR_OPEN;
const BOT_DOOR_COLS = [5, 11, 17, 25];
for (const c of BOT_DOOR_COLS) FLOOR[12][c] = DOOR_OPEN;

// Vertical walls between adjacent rooms in the same row.
function vSplit(rowStart: number, rowEnd: number, col: number) {
  for (let r = rowStart; r <= rowEnd; r++) {
    FLOOR[r][col] = WALL_LEFT; // any vertical wall body works
  }
}
// Top row splits at col 9-10 boundary (Library|Workshop), 13-14 (Workshop|Control), 21-22 (Control|Lounge)
vSplit(4, 9, 10);
vSplit(4, 9, 14);
vSplit(4, 9, 22);
// Bottom row splits same boundaries.
vSplit(13, 18, 10);
vSplit(13, 18, 14);
vSplit(13, 18, 22);

// Exterior path tiles south of the front door — path runs from the door
// down through the south grass band to the map edge.
for (let row = BUILDING_BOT_ROW + 1; row < ROWS; row++) {
  FLOOR[row][FRONT_DOOR_COL] = STONE_PATH;
  FLOOR[row][FRONT_DOOR_COL + 1] = STONE_PATH;
}

// =============================================================================
// Per-room decor placements. Furniture lives on the decor layer; cells
// it covers become non-walkable so NPCs path around them. Multi-tile
// pieces (FRIDGE 1x2, ROUND_TABLE 2x2, etc.) need only their TOP-LEFT
// cell marked — drawSlice expands the span at render time, but we ALSO
// need to mark the additional cells decor != null for walkability.
// =============================================================================

const place = (col: number, row: number, slice: AtlasSlice) => {
  DECOR[row][col] = slice;
  // For multi-tile sprites, mark the covered cells as occupied too.
  const sc = slice.spanCols ?? 1;
  const sr = slice.spanRows ?? 1;
  for (let dr = 0; dr < sr; dr++) {
    for (let dc = 0; dc < sc; dc++) {
      if (dc === 0 && dr === 0) continue;
      DECOR[row + dr][col + dc] = slice; // same slice ref — drawMap skips
                                          // these because the slice is also
                                          // drawn at the top-left, but
                                          // walkability sees them as blocked.
    }
  }
};

// --- Library (rows 4-9, cols 2-9) — bookshelves along the north wall + a
//     reading table near the door.
place(3, 4, BOOKSHELF_TALL);
place(5, 4, BOOKSHELF_TALL);
place(7, 4, BOOKSHELF_TALL);
place(4, 7, READING_TABLE);

// --- Workshop (rows 4-9, cols 10-13) — tight 4-col room. Two desks
//     along the north wall, each with a monitor.
place(11, 4, DESK_TOP_WOOD);
place(11, 5, DESK_BOTTOM_WOOD);
place(11, 4, MONITOR_ON);

// --- Control Room (rows 4-9, cols 14-21) — bank of grey desks +
//     monitors + a server rack.
place(15, 4, DESK_TOP_GREY);
place(15, 5, DESK_BOTTOM_GREY);
place(15, 4, MONITOR_ON);
place(17, 4, DESK_TOP_GREY);
place(17, 5, DESK_BOTTOM_GREY);
place(17, 4, MONITOR_ON);
place(19, 4, DESK_TOP_GREY);
place(19, 5, DESK_BOTTOM_GREY);
place(19, 4, MONITOR_ON);
place(20, 7, SERVER_RACK);
place(15, 8, OFFICE_PLANT_TALL);

// --- Lounge (rows 4-9, cols 22-29) — couches around a coffee table + TV.
place(23, 4, TV_STAND);
place(23, 7, COUCH_LEFT);
place(24, 7, COUCH_MID);
place(25, 7, COUCH_RIGHT);
place(24, 5, COFFEE_TABLE);

// --- Kitchen (rows 13-18, cols 2-9) — fridge + stove + sink along north,
//     dining table center.
place(3, 13, FRIDGE);
place(5, 13, STOVE);
place(6, 13, KITCHEN_SINK);
place(4, 16, KITCHEN_TABLE);

// --- Meeting Room (rows 13-18, cols 10-13) — round table center.
place(11, 15, ROUND_TABLE);

// --- Test Rig (rows 13-18, cols 14-21) — lab benches + tall machines.
place(15, 13, LAB_MACHINE_TALL);
place(17, 14, LAB_BENCH);
place(18, 14, MICROSCOPE);
place(19, 13, LAB_MACHINE_TALL);
place(15, 17, FILE_CABINET);
place(20, 17, PRINTER);

// =============================================================================
// Anchors — where each room's NPC ends up by default. Placed inside the
// room region, near the center, on a known walkable cell.
// =============================================================================
const ANCHORS: Partial<Record<RoomId, { col: number; row: number }>> = {
  library:       { col: 5,  row: 6  },
  coding_room:   { col: 11, row: 6  },
  desk:          { col: 17, row: 6  },
  cinema:        { col: 25, row: 6  },
  tool_workshop: { col: 5,  row: 16 },
  meeting_room:  { col: 11, row: 16 },
  testing_lab:   { col: 17, row: 16 },
};

// Exit anchor — used by walk-in / walk-out. NPCs walk to/from this cell
// outside the building, then fade.
export const EXTERIOR_ANCHORS = {
  entry: { col: FRONT_DOOR_COL, row: ROWS - 1 },
  exit: { col: FRONT_DOOR_COL, row: ROWS - 1 },
};

// Backwards-compat constant some legacy code still imports.
export const ROW_SHIFT_FROM_INTERIOR = 0;

// If map.json has been authored via /map-editor, prefer it over the
// programmatic FLOOR/DECOR painted above. Empty floor[] means "no
// authored map yet" — keep the programmatic fallback.
const useSavedMap =
  Array.isArray(savedMap.floor) &&
  savedMap.floor.length === ROWS &&
  Array.isArray(savedMap.floor[0]) &&
  savedMap.floor[0].length === COLS;

export const INTERIOR_ZONE: ZoneDef = {
  id: "interior",
  name: "Agent Ops",
  cols: COLS,
  rows: ROWS,
  floor: useSavedMap ? savedMap.floor : FLOOR,
  decor: useSavedMap ? savedMap.decor : DECOR,
  anchors: ANCHORS,
};

export const ZONES: Record<ZoneId, ZoneDef> = {
  interior: INTERIOR_ZONE,
};

// =============================================================================
// Walkability
// =============================================================================
//
// Slice equality is reference equality because every TILE_* in
// limezu-tiles.ts is a single shared object literal. We use Set lookups
// for blocking/walkable membership.

// Wall slices that block movement. We compare by shape (atlas+col+row) so
// slices coming from JSON (no reference identity to the TILE_* exports)
// still match correctly.
const BLOCKING_FLOOR_SHAPES = new Set<string>(
  [
    WALL_TOP,
    WALL_BOTTOM,
    WALL_LEFT,
    WALL_RIGHT,
    WALL_CORNER_TL,
    WALL_CORNER_TR,
    WALL_CORNER_BL,
    WALL_CORNER_BR,
    WALL_T_NORTH,
    WALL_T_SOUTH,
  ].map((s) => sliceKey(s)),
);

function sliceKey(s: AtlasSlice): string {
  return `${s.atlas}:${s.col}:${s.row}`;
}

export function isWalkableIn(zone: ZoneDef, col: number, row: number): boolean {
  if (col < 0 || col >= zone.cols || row < 0 || row >= zone.rows) return false;
  const f = zone.floor[row][col];
  // null cells are exterior grass — walkable.
  if (f && BLOCKING_FLOOR_SHAPES.has(sliceKey(f))) return false;
  // Decor that's anything other than null blocks. We don't currently mark
  // any decor as walkable; if we add rugs/posters we'll add a WALKABLE_DECOR
  // set similar to BLOCKING_FLOOR_SHAPES.
  const d = zone.decor[row][col];
  if (d) return false;
  return true;
}
