#!/usr/bin/env node
// seed-map — paint a small starter building into src/game/map.json so the
// /map-editor opens with something to iterate on instead of an empty grid.
//
// Building is intentionally small + simple: one open room with walls,
// floor, a south door, and two pieces of decor. The user is expected to
// edit / expand from here in the /map-editor UI.
//
// Run:  node scripts/seed-map.mjs

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..");
const MAP_PATH = join(REPO_ROOT, "src", "game", "map.json");

const COLS = 32;
const ROWS = 22;

// Tile slices — same shapes the editor reads from limezu-tiles.ts.
// Best-guess coordinates; iterate via /map-editor's raw-atlas tab.
const FLOOR_WOOD = { atlas: "rb_floors", col: 1, row: 7 };
const FLOOR_OFFICE = { atlas: "rb_floors", col: 7, row: 7 };
const FLOOR_TILE = { atlas: "rb_floors", col: 10, row: 7 };
const FLOOR_GOLD = { atlas: "rb_floors", col: 13, row: 7 };

const WALL_TOP = { atlas: "rb_walls", col: 1, row: 1 };
const WALL_BOT = { atlas: "rb_walls", col: 1, row: 3 };
const WALL_LFT = { atlas: "rb_walls", col: 0, row: 2 };
const WALL_RGT = { atlas: "rb_walls", col: 2, row: 2 };
const WALL_TL = { atlas: "rb_walls", col: 0, row: 1 };
const WALL_TR = { atlas: "rb_walls", col: 2, row: 1 };
const WALL_BL = { atlas: "rb_walls", col: 0, row: 3 };
const WALL_BR = { atlas: "rb_walls", col: 2, row: 3 };

const DOOR = { atlas: "rb_arches", col: 1, row: 2 };
const STONE_PATH = { atlas: "rb_paths", col: 1, row: 1 };

const DESK_TOP = { atlas: "office_main", col: 9, row: 0 };
const DESK_BOT = { atlas: "office_main", col: 9, row: 1 };
const MONITOR = { atlas: "office_main", col: 9, row: 2 };
const PLANT = { atlas: "office_main", col: 5, row: 4 };
const BOOKSHELF = {
  atlas: "theme_library",
  col: 0,
  row: 0,
  spanRows: 2,
};
const FRIDGE = {
  atlas: "theme_kitchen",
  col: 0,
  row: 0,
  spanRows: 2,
};
const ROUND_TABLE = {
  atlas: "theme_conference",
  col: 0,
  row: 0,
  spanCols: 2,
  spanRows: 2,
};
const COUCH_L = { atlas: "theme_livingroom", col: 0, row: 0 };
const COUCH_M = { atlas: "theme_livingroom", col: 1, row: 0 };
const COUCH_R = { atlas: "theme_livingroom", col: 2, row: 0 };

const grid = (filler) =>
  Array.from({ length: ROWS }, () => new Array(COLS).fill(filler));

const floor = grid(null);
const decor = grid(null);

// ----- Building outline: 16 cols × 13 rows centered on the map.
// Cols 8..23, rows 4..16 — leaves a 3-tile grass band on north, 5 on south,
// 8 cols on east+west sides for outdoor space.
const B_LEFT = 8;
const B_RIGHT = 23;
const B_TOP = 4;
const B_BOT = 16;
const FRONT_DOOR_COL = 15;

// Top + bottom walls.
for (let c = B_LEFT; c <= B_RIGHT; c++) {
  floor[B_TOP][c] = WALL_TOP;
  floor[B_BOT][c] = WALL_BOT;
}
// Side walls.
for (let r = B_TOP; r <= B_BOT; r++) {
  floor[r][B_LEFT] = WALL_LFT;
  floor[r][B_RIGHT] = WALL_RGT;
}
// Corners.
floor[B_TOP][B_LEFT] = WALL_TL;
floor[B_TOP][B_RIGHT] = WALL_TR;
floor[B_BOT][B_LEFT] = WALL_BL;
floor[B_BOT][B_RIGHT] = WALL_BR;
// Front door — south wall, walkable.
floor[B_BOT][FRONT_DOOR_COL] = DOOR;

// ----- 4-quadrant interior: a small "preview" of what each room will be.
// Top-left  = Library (wood floor + bookshelf)
// Top-right = Workshop (office floor + desk + monitor)
// Bot-left  = Lounge (gold floor + couches)
// Bot-right = Kitchen (tile floor + fridge + round table)
//
// Internal split: a vertical wall at col 15, gap at row 10 for a corridor
// connecting top and bottom halves. Rooms overlap horizontally so we use
// floor tints to differentiate.
for (let r = B_TOP + 1; r < B_BOT; r++) {
  for (let c = B_LEFT + 1; c < B_RIGHT; c++) {
    const inLeft = c < FRONT_DOOR_COL;
    const inTop = r < 10;
    if (inTop && inLeft) floor[r][c] = FLOOR_WOOD;
    else if (inTop && !inLeft) floor[r][c] = FLOOR_OFFICE;
    else if (!inTop && inLeft) floor[r][c] = FLOOR_GOLD;
    else floor[r][c] = FLOOR_TILE;
  }
}

// Internal vertical wall (between left + right halves), with a 2-tile gap
// in the corridor row so NPCs can cross.
for (let r = B_TOP + 1; r < B_BOT; r++) {
  if (r === 10 || r === 11) continue; // corridor gap
  floor[r][FRONT_DOOR_COL] = WALL_LFT;
}

// Internal horizontal wall (between top + bottom halves), with a gap so
// NPCs can move between rooms.
for (let c = B_LEFT + 1; c < B_RIGHT; c++) {
  if (c === FRONT_DOOR_COL || c === FRONT_DOOR_COL + 1) continue; // gap
  // Skip the cell that already holds the vertical wall.
  if (c === FRONT_DOOR_COL) continue;
  floor[10][c] = WALL_TOP;
}

// ----- Decor: a couple of pieces per quadrant so the rooms aren't bare.
//   Top-left (Library): bookshelves along the north wall.
decor[B_TOP + 1][B_LEFT + 2] = BOOKSHELF;
decor[B_TOP + 1][B_LEFT + 4] = BOOKSHELF;

//   Top-right (Workshop): a desk + monitor + a plant in the corner.
decor[B_TOP + 1][FRONT_DOOR_COL + 2] = DESK_TOP;
decor[B_TOP + 2][FRONT_DOOR_COL + 2] = DESK_BOT;
decor[B_TOP + 1][FRONT_DOOR_COL + 2] = MONITOR; // monitor on top of desk
decor[B_TOP + 1][B_RIGHT - 1] = PLANT;

//   Bot-left (Lounge): a 3-piece couch.
decor[B_BOT - 2][B_LEFT + 2] = COUCH_L;
decor[B_BOT - 2][B_LEFT + 3] = COUCH_M;
decor[B_BOT - 2][B_LEFT + 4] = COUCH_R;

//   Bot-right (Kitchen): fridge + round table.
decor[B_BOT - 4][FRONT_DOOR_COL + 2] = FRIDGE;
decor[B_BOT - 2][FRONT_DOOR_COL + 4] = ROUND_TABLE;

// ----- Exterior: stone path from the front door down to the south edge.
for (let r = B_BOT + 1; r < ROWS; r++) {
  floor[r][FRONT_DOOR_COL] = STONE_PATH;
  floor[r][FRONT_DOOR_COL + 1] = STONE_PATH;
}

const map = {
  cols: COLS,
  rows: ROWS,
  tileSize: 16,
  floor,
  decor,
};

writeFileSync(MAP_PATH, JSON.stringify(map, null, 2));
console.log(`[seed-map] wrote ${MAP_PATH}`);
console.log(`[seed-map] painted: 1 building (${B_RIGHT - B_LEFT + 1}×${B_BOT - B_TOP + 1}), 4 quadrants, 1 door, exterior path.`);
