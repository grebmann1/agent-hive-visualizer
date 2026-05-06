// limezu-tiles.ts — semantic TILE catalog for the LimeZu pipeline.
//
// Each entry is an AtlasSlice — `(atlas key, col, row[, spanCols, spanRows])`.
// Coordinates picked using the /atlas inspector. First-pass educated
// guesses; iterate by visiting /atlas, hovering tiles, and updating here.
//
// Conventions:
//   - LimeZu's room-builder atlases group tiles into 3-col modules
//     [left-edge, body, right-edge]. We expose the body cell as the
//     "main" floor/wall and the edge cells as suffix variants for use
//     when rendering room corners.
//   - Wall atlas (rb_walls, 32×40) modules occupy 3 cols. There are
//     ~10 modules per column-block; we pick row offsets that look
//     consistent on initial visual inspection.
//   - All tiles are 16×16 unless spanCols/spanRows say otherwise.

import type { AtlasSlice } from "./atlas";

// =============================================================================
// FLOORS (atlas: rb_floors, 15×40 grid, 3-col modules per pattern)
// =============================================================================
//
// rb_floors lays out 5 columns of floor "patches", each patch is a 3×3
// tile module showing center + 8 edge variants. We just want the center
// tile of each patch for tiling. Picking the body cell of distinct
// patches we saw: wood-light, wood-dark, grey-concrete, terracotta-tile,
// gold-carpet.

export const FLOOR_WOOD_LIGHT: AtlasSlice = { atlas: "rb_floors", col: 1, row: 7 };
export const FLOOR_WOOD_DARK: AtlasSlice = { atlas: "rb_floors", col: 4, row: 7 };
export const FLOOR_OFFICE_GREY: AtlasSlice = { atlas: "rb_floors", col: 7, row: 7 };
export const FLOOR_TILE_TERRACOTTA: AtlasSlice = { atlas: "rb_floors", col: 10, row: 7 };
export const FLOOR_CARPET_GOLD: AtlasSlice = { atlas: "rb_floors", col: 13, row: 7 };

// =============================================================================
// WALLS (atlas: rb_walls, 32×40 grid)
// =============================================================================
//
// LimeZu wall modules are 3-col stacks: [vertical-edge, top-cap, bottom-cap]
// or similar. For our flat top-down map we mostly need:
//   - WALL_TOP: horizontal top wall body
//   - WALL_BOTTOM: horizontal bottom wall body
//   - WALL_LEFT, WALL_RIGHT: vertical wall sides
//   - WALL_*_CORNER: 4 corners
// Picking from a neutral wall module (left third of the atlas).

export const WALL_TOP: AtlasSlice = { atlas: "rb_walls", col: 1, row: 1 };
export const WALL_BOTTOM: AtlasSlice = { atlas: "rb_walls", col: 1, row: 3 };
export const WALL_LEFT: AtlasSlice = { atlas: "rb_walls", col: 0, row: 2 };
export const WALL_RIGHT: AtlasSlice = { atlas: "rb_walls", col: 2, row: 2 };
export const WALL_CORNER_TL: AtlasSlice = { atlas: "rb_walls", col: 0, row: 1 };
export const WALL_CORNER_TR: AtlasSlice = { atlas: "rb_walls", col: 2, row: 1 };
export const WALL_CORNER_BL: AtlasSlice = { atlas: "rb_walls", col: 0, row: 3 };
export const WALL_CORNER_BR: AtlasSlice = { atlas: "rb_walls", col: 2, row: 3 };

// T-junctions (where corridor meets room wall)
export const WALL_T_NORTH: AtlasSlice = { atlas: "rb_walls", col: 1, row: 5 };
export const WALL_T_SOUTH: AtlasSlice = { atlas: "rb_walls", col: 1, row: 6 };

// =============================================================================
// DOORS (atlas: rb_arches, 10×32 grid)
// =============================================================================
//
// Arched entryways. Each module stacks an "open-doorway" pair vertically;
// we want the bottom (walkable) tile and treat the top tile as decor on
// the wall row. For a single-tile door gap we use just the bottom.

export const DOOR_OPEN: AtlasSlice = { atlas: "rb_arches", col: 1, row: 2 };

// =============================================================================
// OFFICE FURNITURE (atlas: office_main, 16×53 grid)
// =============================================================================
//
// office_main row layout (eyeballed from the atlas image):
//   rows 0-1:  segmented desks (light wood / med wood / dark wood / grey)
//   rows 2-3:  monitors + computer setups
//   row  4:    plants, trash bins, posters
//   rows 5-7:  chairs (multiple colors + facings)
//   rows 8-12: file cabinets + lockers
//   rows 13-15: water cooler + printer + fax
//   rows 16+:  full desk modules with monitor + chair, server racks
//
// A LimeZu single desk is typically 1×2 (top+bottom). Monitor sits on
// desk top.

export const DESK_TOP_GREY: AtlasSlice = { atlas: "office_main", col: 9, row: 0 };
export const DESK_BOTTOM_GREY: AtlasSlice = { atlas: "office_main", col: 9, row: 1 };
export const DESK_TOP_WOOD: AtlasSlice = { atlas: "office_main", col: 0, row: 0 };
export const DESK_BOTTOM_WOOD: AtlasSlice = { atlas: "office_main", col: 0, row: 1 };

export const MONITOR_OFF: AtlasSlice = { atlas: "office_main", col: 9, row: 2 };
export const MONITOR_ON: AtlasSlice = { atlas: "office_main", col: 10, row: 2 };
export const KEYBOARD_MOUSE: AtlasSlice = { atlas: "office_main", col: 11, row: 2 };

export const OFFICE_CHAIR_DOWN: AtlasSlice = { atlas: "office_main", col: 0, row: 5 };
export const OFFICE_CHAIR_UP: AtlasSlice = { atlas: "office_main", col: 1, row: 5 };
export const OFFICE_CHAIR_LEFT: AtlasSlice = { atlas: "office_main", col: 2, row: 5 };
export const OFFICE_CHAIR_RIGHT: AtlasSlice = { atlas: "office_main", col: 3, row: 5 };

export const OFFICE_PLANT_TALL: AtlasSlice = { atlas: "office_main", col: 5, row: 4 };
export const OFFICE_PLANT_SHORT: AtlasSlice = { atlas: "office_main", col: 6, row: 4 };

export const POSTER_SMALL: AtlasSlice = { atlas: "office_main", col: 0, row: 4 };
export const POSTER_MEDIUM: AtlasSlice = { atlas: "office_main", col: 1, row: 4 };

export const FILE_CABINET: AtlasSlice = { atlas: "office_main", col: 0, row: 9 };
export const SERVER_RACK: AtlasSlice = { atlas: "office_main", col: 0, row: 10, spanRows: 2 };

export const PRINTER: AtlasSlice = { atlas: "office_main", col: 8, row: 13 };
export const WATER_COOLER: AtlasSlice = { atlas: "office_main", col: 0, row: 13 };

// Full desk-with-monitor module (2-tile tall workstation, ready-made).
export const DESK_MODULE: AtlasSlice = {
  atlas: "office_main",
  col: 9,
  row: 16,
  spanRows: 2,
};

// =============================================================================
// LIBRARY (atlas: theme_library, 16×34 grid — Classroom_and_library)
// =============================================================================

export const BOOKSHELF_TALL: AtlasSlice = {
  atlas: "theme_library",
  col: 0,
  row: 0,
  spanRows: 2,
};
export const BOOKSHELF_SHORT: AtlasSlice = { atlas: "theme_library", col: 4, row: 0 };
export const READING_TABLE: AtlasSlice = { atlas: "theme_library", col: 8, row: 4 };
export const CHALKBOARD: AtlasSlice = {
  atlas: "theme_library",
  col: 10,
  row: 0,
  spanCols: 2,
};

// =============================================================================
// KITCHEN (atlas: theme_kitchen, 16×49 grid)
// =============================================================================

export const FRIDGE: AtlasSlice = {
  atlas: "theme_kitchen",
  col: 0,
  row: 0,
  spanRows: 2,
};
export const STOVE: AtlasSlice = { atlas: "theme_kitchen", col: 3, row: 0 };
export const KITCHEN_SINK: AtlasSlice = { atlas: "theme_kitchen", col: 5, row: 0 };
export const COUNTER_LEFT: AtlasSlice = { atlas: "theme_kitchen", col: 7, row: 0 };
export const COUNTER_MID: AtlasSlice = { atlas: "theme_kitchen", col: 8, row: 0 };
export const COUNTER_RIGHT: AtlasSlice = { atlas: "theme_kitchen", col: 9, row: 0 };
export const KITCHEN_TABLE: AtlasSlice = {
  atlas: "theme_kitchen",
  col: 0,
  row: 4,
  spanCols: 2,
};

// =============================================================================
// MEETING ROOM (atlas: theme_conference, 16×12 grid)
// =============================================================================
//
// theme_conference is small (192 px tall) and centered on conference
// hall furniture. The 2×2 round table is at the top-left.

export const ROUND_TABLE: AtlasSlice = {
  atlas: "theme_conference",
  col: 0,
  row: 0,
  spanCols: 2,
  spanRows: 2,
};
export const CONFERENCE_CHAIR_DOWN: AtlasSlice = {
  atlas: "theme_conference",
  col: 4,
  row: 0,
};
export const CONFERENCE_CHAIR_UP: AtlasSlice = {
  atlas: "theme_conference",
  col: 5,
  row: 0,
};
export const CONFERENCE_CHAIR_LEFT: AtlasSlice = {
  atlas: "theme_conference",
  col: 6,
  row: 0,
};
export const CONFERENCE_CHAIR_RIGHT: AtlasSlice = {
  atlas: "theme_conference",
  col: 7,
  row: 0,
};
export const WHITEBOARD: AtlasSlice = {
  atlas: "theme_conference",
  col: 9,
  row: 0,
  spanCols: 2,
};

// =============================================================================
// TEST RIG (atlas: theme_hospital, 16×110 grid)
// =============================================================================

export const LAB_MACHINE_TALL: AtlasSlice = {
  atlas: "theme_hospital",
  col: 0,
  row: 0,
  spanRows: 2,
};
export const LAB_BENCH: AtlasSlice = { atlas: "theme_hospital", col: 3, row: 0 };
export const MICROSCOPE: AtlasSlice = { atlas: "theme_hospital", col: 5, row: 0 };
export const HOSPITAL_BED: AtlasSlice = {
  atlas: "theme_hospital",
  col: 7,
  row: 0,
  spanRows: 2,
};

// =============================================================================
// LOUNGE (atlas: theme_livingroom, 16×45 grid)
// =============================================================================

export const COUCH_LEFT: AtlasSlice = { atlas: "theme_livingroom", col: 0, row: 0 };
export const COUCH_MID: AtlasSlice = { atlas: "theme_livingroom", col: 1, row: 0 };
export const COUCH_RIGHT: AtlasSlice = { atlas: "theme_livingroom", col: 2, row: 0 };
export const COFFEE_TABLE: AtlasSlice = { atlas: "theme_livingroom", col: 4, row: 0 };
export const TV_STAND: AtlasSlice = {
  atlas: "theme_livingroom",
  col: 6,
  row: 0,
  spanCols: 2,
};
export const LOUNGE_RUG: AtlasSlice = {
  atlas: "theme_livingroom",
  col: 9,
  row: 0,
  spanCols: 2,
  spanRows: 2,
};

// =============================================================================
// EXTERIOR (atlas: rb_paths, 42×12 grid)
// =============================================================================
//
// rb_paths includes dirt + stone path tiles. We use rows of the base
// path body — neighbor cells are edge variants we don't need yet.

export const STONE_PATH: AtlasSlice = { atlas: "rb_paths", col: 1, row: 1 };
export const DIRT_PATH: AtlasSlice = { atlas: "rb_paths", col: 4, row: 1 };

// =============================================================================
// REGISTRY — useful for the inspector route to render "every tile we use"
// in one place. Also used by validateAllSlices() to catch typos at boot.
// =============================================================================

export const ALL_TILES: Record<string, AtlasSlice> = {
  FLOOR_WOOD_LIGHT,
  FLOOR_WOOD_DARK,
  FLOOR_OFFICE_GREY,
  FLOOR_TILE_TERRACOTTA,
  FLOOR_CARPET_GOLD,
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
  DOOR_OPEN,
  DESK_TOP_GREY,
  DESK_BOTTOM_GREY,
  DESK_TOP_WOOD,
  DESK_BOTTOM_WOOD,
  MONITOR_OFF,
  MONITOR_ON,
  KEYBOARD_MOUSE,
  OFFICE_CHAIR_DOWN,
  OFFICE_CHAIR_UP,
  OFFICE_CHAIR_LEFT,
  OFFICE_CHAIR_RIGHT,
  OFFICE_PLANT_TALL,
  OFFICE_PLANT_SHORT,
  POSTER_SMALL,
  POSTER_MEDIUM,
  FILE_CABINET,
  SERVER_RACK,
  PRINTER,
  WATER_COOLER,
  DESK_MODULE,
  BOOKSHELF_TALL,
  BOOKSHELF_SHORT,
  READING_TABLE,
  CHALKBOARD,
  FRIDGE,
  STOVE,
  KITCHEN_SINK,
  COUNTER_LEFT,
  COUNTER_MID,
  COUNTER_RIGHT,
  KITCHEN_TABLE,
  ROUND_TABLE,
  CONFERENCE_CHAIR_DOWN,
  CONFERENCE_CHAIR_UP,
  CONFERENCE_CHAIR_LEFT,
  CONFERENCE_CHAIR_RIGHT,
  WHITEBOARD,
  LAB_MACHINE_TALL,
  LAB_BENCH,
  MICROSCOPE,
  HOSPITAL_BED,
  COUCH_LEFT,
  COUCH_MID,
  COUCH_RIGHT,
  COFFEE_TABLE,
  TV_STAND,
  LOUNGE_RUG,
  STONE_PATH,
  DIRT_PATH,
};
