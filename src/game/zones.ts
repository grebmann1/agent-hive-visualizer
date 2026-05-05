import type { RoomId } from "../events/types";
import { TILE } from "./pixelArt";

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

// D2 — Workstation clusters for the open-plan interior.
// IDE bullpen (top-left, anchor col 4 row 4) — three desk/chair pairs.
p2(INTERIOR_DECOR, 2, 2, TILE.DESK_TOP, TILE.DESK_BOTTOM);
p2(INTERIOR_DECOR, 4, 2, TILE.DESK_TOP, TILE.DESK_BOTTOM);
p2(INTERIOR_DECOR, 6, 2, TILE.DESK_TOP, TILE.DESK_BOTTOM);
p1(INTERIOR_DECOR, 2, 5, TILE.CHAIR);
p1(INTERIOR_DECOR, 4, 5, TILE.CHAIR);
p1(INTERIOR_DECOR, 6, 5, TILE.CHAIR);

// Ops Center (top-center, anchor col 11 row 4) — 2×2 desk grid + rug patch.
p2(INTERIOR_DECOR, 10, 2, TILE.DESK_TOP, TILE.DESK_BOTTOM);
p2(INTERIOR_DECOR, 11, 2, TILE.DESK_TOP, TILE.DESK_BOTTOM);
p1(INTERIOR_DECOR, 10, 4, TILE.RUG);
p1(INTERIOR_DECOR, 11, 4, TILE.RUG);

// Knowledge Base (top-right, anchor col 19 row 4) — shelf wall effect.
p2(INTERIOR_DECOR, 17, 1, TILE.BOOKSHELF_TOP, TILE.BOOKSHELF_BOTTOM);
p2(INTERIOR_DECOR, 19, 1, TILE.BOOKSHELF_TOP, TILE.BOOKSHELF_BOTTOM);
p2(INTERIOR_DECOR, 21, 1, TILE.BOOKSHELF_TOP, TILE.BOOKSHELF_BOTTOM);

// Build Bay (bottom-left, anchor col 5 row 12) — three gear pairs + rug strip.
p2(INTERIOR_DECOR, 2, 9, TILE.GEAR_TOP, TILE.GEAR_BOTTOM);
p2(INTERIOR_DECOR, 5, 9, TILE.GEAR_TOP, TILE.GEAR_BOTTOM);
p2(INTERIOR_DECOR, 8, 9, TILE.GEAR_TOP, TILE.GEAR_BOTTOM);
for (let c = 2; c <= 8; c++) p1(INTERIOR_DECOR, c, 11, TILE.RUG);

// Test Rig (bottom-right, anchor col 17 row 12) — three lab pairs.
p2(INTERIOR_DECOR, 14, 9, TILE.LAB_TOP, TILE.LAB_BOTTOM);
p2(INTERIOR_DECOR, 17, 9, TILE.LAB_TOP, TILE.LAB_BOTTOM);
p2(INTERIOR_DECOR, 20, 9, TILE.LAB_TOP, TILE.LAB_BOTTOM);

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

export const INTERIOR_ZONE: ZoneDef = {
  id: "interior",
  name: "Agent Ops",
  cols: INTERIOR_COLS,
  rows: INTERIOR_ROWS,
  layout: INTERIOR_LAYOUT,
  decor: INTERIOR_DECOR,
  anchors: {
    coding_room: { col: 4, row: 4 },
    desk: { col: 11, row: 4 },
    library: { col: 19, row: 4 },
    tool_workshop: { col: 5, row: 12 },
    testing_lab: { col: 17, row: 12 },
    // Center aisle of the cinema — used as the "arrived at cinema" fallback
    // when no specific seat is available.
    cinema: { col: 11, row: 19 },
  },
};

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
    return false;
  }
  return true;
}

