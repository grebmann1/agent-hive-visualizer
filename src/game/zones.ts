import type { RoomId } from "../events/types";
import { EXT_GRASS, EXT_PATH, EXT_TREE, TILE } from "./pixelArt";

// Single interior zone — the "factory floor" of Agent Ops. v2.0 removed
// the multi-zone system (plaza door / transitions) when the player avatar
// was removed; there's no entity to step on a transition tile anymore.
//
// The ZoneDef structure remains as a convenient container for:
//   layout: base tile layer (walls + floor)
//   decor:  furniture tiles drawn above floor
//   anchors: map of RoomId -> tile position (for NPC spawning + labels)

export type ZoneId = "interior";

export interface ZoneDef {
  id: ZoneId;
  name: string;
  cols: number;
  rows: number;
  layout: number[][]; // base tile id per cell
  decor: number[][]; // decor tile id per cell (-1 = none)
  anchors: Partial<Record<RoomId, { col: number; row: number }>>;
}

// ============================================================================
// INTERIOR — existing 24×16 layout moved here verbatim from rooms.ts
// ============================================================================

const F = TILE.FLOOR;
const W = TILE.WALL_SOLID;

const INTERIOR_COLS = 24;
const INTERIOR_ROWS = 22;

// Open-plan interior (D1):
// - Outer walls only on row 0, row 21, col 0, and col 23.
// - The row-7 horizontal wall is gone — the top half (rows 1-14) is one large
//   floor housing the IDE, Ops Center, and Knowledge Base clusters.
// - Row 15 is a half-open partition into the Lounge with a 3-tile gap at
//   cols 11-13 (was 1-tile gap).
// - Row 21 keeps the plaza-door gap at col 12.
const INTERIOR_LAYOUT: number[][] = [
  [W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  // row 15: partition between main floor + Lounge, 3-tile gap at cols 11-13
  [W, W, W, W, W, W, W, W, W, W, W, F, F, F, W, W, W, W, W, W, W, W, W, W],
  // rows 16–20 — Lounge floor
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
  // row 21: bottom wall with door-gap at col 12 → plaza
  [W, W, W, W, W, W, W, W, W, W, W, W, F, W, W, W, W, W, W, W, W, W, W, W],
];

const INTERIOR_DECOR: number[][] = Array.from({ length: INTERIOR_ROWS }, () =>
  new Array(INTERIOR_COLS).fill(-1),
);

function p2(grid: number[][], col: number, row: number, a: number, b: number) {
  grid[row][col] = a;
  grid[row + 1][col] = b;
}
function p1(grid: number[][], col: number, row: number, t: number) {
  grid[row][col] = t;
}

// D2 — Per-room furniture. CP4: each room uses a distinct arrangement and
// the WorldScene.drawMap pass tints decor by room accent so rooms read as
// visually different even though we're drawing from one tileset.
//
// Workshop (coding_room, top-left, anchor col 4 row 4) — row of workbenches
// pushed against the top wall so there's open floor for pathing.
p2(INTERIOR_DECOR, 2, 1, TILE.DESK_TOP, TILE.DESK_BOTTOM);
p2(INTERIOR_DECOR, 4, 1, TILE.DESK_TOP, TILE.DESK_BOTTOM);
p2(INTERIOR_DECOR, 6, 1, TILE.DESK_TOP, TILE.DESK_BOTTOM);
// Anvils on the south side to reinforce "maker space" feel.
p1(INTERIOR_DECOR, 3, 4, TILE.GEAR_TOP);
p1(INTERIOR_DECOR, 7, 4, TILE.GEAR_TOP);

// Control Room (desk, top-center, anchor col 11 row 4) — tight 2×2 desk
// cluster with a rug carpet patch. The monitors read as "command center".
p2(INTERIOR_DECOR, 10, 2, TILE.DESK_TOP, TILE.DESK_BOTTOM);
p2(INTERIOR_DECOR, 12, 2, TILE.DESK_TOP, TILE.DESK_BOTTOM);
p1(INTERIOR_DECOR, 11, 4, TILE.RUG);
p1(INTERIOR_DECOR, 12, 4, TILE.RUG);
p1(INTERIOR_DECOR, 13, 4, TILE.RUG);

// Library (top-right, anchor col 19 row 4) — two shelf-walls to make a
// proper reading stack. Plants flank the aisle.
p2(INTERIOR_DECOR, 16, 1, TILE.BOOKSHELF_TOP, TILE.BOOKSHELF_BOTTOM);
p2(INTERIOR_DECOR, 18, 1, TILE.BOOKSHELF_TOP, TILE.BOOKSHELF_BOTTOM);
p2(INTERIOR_DECOR, 20, 1, TILE.BOOKSHELF_TOP, TILE.BOOKSHELF_BOTTOM);
p2(INTERIOR_DECOR, 22, 1, TILE.BOOKSHELF_TOP, TILE.BOOKSHELF_BOTTOM);
p1(INTERIOR_DECOR, 17, 4, TILE.PLANT);
p1(INTERIOR_DECOR, 21, 4, TILE.PLANT);

// Kitchen (tool_workshop, bottom-left, anchor col 5 row 12) — bookshelves
// double as counter cabinets along the top wall of the room; plants =
// herbs. Rug strip is the tile "path".
p2(INTERIOR_DECOR, 2, 8, TILE.BOOKSHELF_TOP, TILE.BOOKSHELF_BOTTOM);
p2(INTERIOR_DECOR, 4, 8, TILE.BOOKSHELF_TOP, TILE.BOOKSHELF_BOTTOM);
p2(INTERIOR_DECOR, 6, 8, TILE.BOOKSHELF_TOP, TILE.BOOKSHELF_BOTTOM);
p2(INTERIOR_DECOR, 8, 8, TILE.BOOKSHELF_TOP, TILE.BOOKSHELF_BOTTOM);
p1(INTERIOR_DECOR, 3, 11, TILE.PLANT);
p1(INTERIOR_DECOR, 10, 11, TILE.PLANT);
for (let c = 2; c <= 10; c++) {
  if (INTERIOR_DECOR[12][c] === -1) p1(INTERIOR_DECOR, c, 12, TILE.RUG);
}

// Test Rig (bottom-right, anchor col 17 row 12) — two lab-bench pairs
// plus a gear as a stand-in for lab equipment. Col-14 bench moved
// elsewhere so the Meeting Room pocket has space.
p2(INTERIOR_DECOR, 17, 9, TILE.LAB_TOP, TILE.LAB_BOTTOM);
p2(INTERIOR_DECOR, 20, 9, TILE.LAB_TOP, TILE.LAB_BOTTOM);
p1(INTERIOR_DECOR, 18, 12, TILE.GEAR_TOP);
p1(INTERIOR_DECOR, 21, 12, TILE.GEAR_TOP);

// Meeting Room (anchor col 13 row 8) — tiny round-table pocket. Put the
// LAB_TOP tile at (14,7) as a visual centerpiece "round table" and
// cluster chairs + rug around it. NPCs target (13, 8) so keep that
// walkable.
p1(INTERIOR_DECOR, 14, 7, TILE.LAB_TOP);
p1(INTERIOR_DECOR, 14, 8, TILE.RUG);
p1(INTERIOR_DECOR, 15, 8, TILE.RUG);
p1(INTERIOR_DECOR, 14, 9, TILE.RUG);
p1(INTERIOR_DECOR, 15, 9, TILE.RUG);

// D3 — Aisle markings. RUG tiles are walkable; skip cells already claimed by
// workstation decor so we don't overwrite a DESK/GEAR/LAB.
//   Main aisle: row 6, cols 3-20 — open row between top and bottom halves.
for (let c = 3; c <= 20; c++) {
  if (INTERIOR_DECOR[6][c] === -1) p1(INTERIOR_DECOR, c, 6, TILE.RUG);
}
//   Lounge threshold aisle: row 13, cols 3-20.
for (let c = 3; c <= 20; c++) {
  if (INTERIOR_DECOR[13][c] === -1) p1(INTERIOR_DECOR, c, 13, TILE.RUG);
}
//   Central corridor: col 11, rows 7-12 (connects the two aisles).
for (let r = 7; r <= 12; r++) {
  if (INTERIOR_DECOR[r][11] === -1) p1(INTERIOR_DECOR, 11, r, TILE.RUG);
}

// Cinema — screen panels along the top wall + 8 chairs in two rows of 4.
// Row 16 has the "screen" (bookshelves stand in for tall panels), row 18/19
// hold the seats. Aisle down the middle (col 11-12) keeps the door-gap walkable.
p1(INTERIOR_DECOR, 4, 16, TILE.BOOKSHELF_TOP);
p1(INTERIOR_DECOR, 7, 16, TILE.BOOKSHELF_TOP);
p1(INTERIOR_DECOR, 16, 16, TILE.BOOKSHELF_TOP);
p1(INTERIOR_DECOR, 19, 16, TILE.BOOKSHELF_TOP);
// Seating is drawn as RUG tiles (which are walkable — NPCs need to stand on
// the tile to sit on the seat) rather than CHAIR tiles (which block movement).
// The visual is a carpet patch suggesting "this is a seat".
// Row 18 seats
p1(INTERIOR_DECOR, 4, 18, TILE.RUG);
p1(INTERIOR_DECOR, 7, 18, TILE.RUG);
p1(INTERIOR_DECOR, 16, 18, TILE.RUG);
p1(INTERIOR_DECOR, 19, 18, TILE.RUG);
// Row 19 seats
p1(INTERIOR_DECOR, 4, 19, TILE.RUG);
p1(INTERIOR_DECOR, 7, 19, TILE.RUG);
p1(INTERIOR_DECOR, 16, 19, TILE.RUG);
p1(INTERIOR_DECOR, 19, 19, TILE.RUG);

// ============================================================================
// EXTERIOR — wrap the interior with grass + a south path. CP5.
// ============================================================================
//
// The interior layout above stays byte-for-byte identical. We compose a
// new zone that pads the interior with `EXT_ROWS_TOP` rows of grass above
// and `EXT_ROWS_BOTTOM` rows below (no side padding — the map already has
// plenty of horizontal slack). Anchors get shifted by EXT_ROWS_TOP so
// existing ROOM_ANCHORS in rooms.ts (which read from INTERIOR_ZONE.anchors)
// keep pointing to the right interior cell.

const EXT_ROWS_TOP = 3;
const EXT_ROWS_BOTTOM = 5;
const EXT_COLS = INTERIOR_COLS;
const EXT_TOTAL_ROWS = INTERIOR_ROWS + EXT_ROWS_TOP + EXT_ROWS_BOTTOM;

// Build the wrapped layout: grass rows, then interior (with walls intact),
// then grass + path rows. Col 12's south wall door gap (original row 21)
// becomes a path from there down to the bottom edge.
const EXT_LAYOUT: number[][] = Array.from({ length: EXT_TOTAL_ROWS }, (_, r) => {
  // Interior rows sit in [EXT_ROWS_TOP, EXT_ROWS_TOP + INTERIOR_ROWS).
  const interiorRow = r - EXT_ROWS_TOP;
  if (interiorRow >= 0 && interiorRow < INTERIOR_ROWS) {
    return INTERIOR_LAYOUT[interiorRow].slice();
  }
  // Exterior row — all grass by default.
  return new Array(EXT_COLS).fill(EXT_GRASS);
});

const EXT_DECOR: number[][] = Array.from({ length: EXT_TOTAL_ROWS }, (_, r) => {
  const interiorRow = r - EXT_ROWS_TOP;
  if (interiorRow >= 0 && interiorRow < INTERIOR_ROWS) {
    return INTERIOR_DECOR[interiorRow].slice();
  }
  return new Array(EXT_COLS).fill(-1);
});

// Carve a 2-tile-wide dirt path from the south door-gap (original interior
// row 21, col 12 — which is shifted-row 21+EXT_ROWS_TOP in the wrapped
// layout) straight down to the bottom edge.
const DOOR_COL = 12;
const PATH_START_ROW = EXT_ROWS_TOP + INTERIOR_ROWS; // first exterior row below the south wall
for (let r = PATH_START_ROW; r < EXT_TOTAL_ROWS; r++) {
  EXT_LAYOUT[r][DOOR_COL] = EXT_PATH;
  EXT_LAYOUT[r][DOOR_COL + 1] = EXT_PATH;
}

// Sprinkle a few trees around the building so the exterior doesn't look
// empty. Trees live in the decor layer so NPCs can walk on their base tile;
// WorldScene draws them at a higher depth. They're visual-only for now —
// walkability is driven by the base layout (EXT_GRASS is walkable).
const TREE_CELLS: Array<[number, number]> = [
  [2, 1], [5, 0], [8, 1], [15, 0], [19, 1], [22, 1],   // north
  [1, PATH_START_ROW + 2], [3, PATH_START_ROW + 4],    // south-west
  [6, PATH_START_ROW + 1], [9, PATH_START_ROW + 3],
  [16, PATH_START_ROW + 2], [19, PATH_START_ROW + 4],  // south-east
  [22, PATH_START_ROW + 1],
];
for (const [col, row] of TREE_CELLS) {
  if (row >= 0 && row < EXT_TOTAL_ROWS && col >= 0 && col < EXT_COLS) {
    EXT_DECOR[row][col] = EXT_TREE;
  }
}

// Shift anchors down by EXT_ROWS_TOP so RoomId → cell lookup lands inside
// the wrapped interior (the original anchor coords are interior-relative).
function shiftAnchor(a: { col: number; row: number }) {
  return { col: a.col, row: a.row + EXT_ROWS_TOP };
}

export const INTERIOR_ZONE: ZoneDef = {
  id: "interior",
  name: "Agent Ops",
  cols: EXT_COLS,
  rows: EXT_TOTAL_ROWS,
  layout: EXT_LAYOUT,
  decor: EXT_DECOR,
  anchors: {
    coding_room: shiftAnchor({ col: 4, row: 4 }),
    desk: shiftAnchor({ col: 11, row: 4 }),
    library: shiftAnchor({ col: 19, row: 4 }),
    tool_workshop: shiftAnchor({ col: 5, row: 12 }),
    testing_lab: shiftAnchor({ col: 17, row: 12 }),
    cinema: shiftAnchor({ col: 11, row: 19 }),
    meeting_room: shiftAnchor({ col: 13, row: 8 }),
  },
};

// Exported for WorldScene's walk-in/out: the path tile just south of the
// door, shifted to wrapped-layout coords.
export const EXTERIOR_ANCHORS = {
  entry: { col: DOOR_COL, row: EXT_TOTAL_ROWS - 1 },
  exit:  { col: DOOR_COL, row: EXT_TOTAL_ROWS - 1 },
};

export const ROW_SHIFT_FROM_INTERIOR = EXT_ROWS_TOP;

export const ZONES: Record<ZoneId, ZoneDef> = {
  interior: INTERIOR_ZONE,
};

export function isWalkableIn(zone: ZoneDef, col: number, row: number): boolean {
  if (col < 0 || col >= zone.cols || row < 0 || row >= zone.rows) return false;
  const floor = zone.layout[row][col];
  if (floor === TILE.WALL_SOLID || floor === TILE.WALL_TOP || floor === TILE.WALL_LOW) {
    return false;
  }
  const dec = zone.decor[row][col];
  if (dec !== -1) {
    if (dec === TILE.RUG || dec === TILE.DOOR_OPEN) return true;
    // Trees are visual-only: NPCs can walk past the trunk cell in CP5
    // because there's no hard collision model for the trunk anyway —
    // the sprite draws at the cell origin and doesn't occlude pathing.
    if (dec === EXT_TREE) return true;
    return false;
  }
  return true;
}

