// rooms.ts — labels + region rectangles + walkability shim.
//
// The canonical world geometry lives in `zones.ts`, which is async-loaded
// from the Tiled `.tmj` at scene start. Anchors + regions are derived
// from named objects in the .tmj so renaming/moving rooms in Tiled is
// the only thing you need to do — code adapts.
//
// Until the load finishes, this shim returns sensible fallbacks so
// pathfind helpers / store init don't crash.

import type { RoomId } from "../events/types";
import type { ZoneDef } from "./zones";
import type { RoomAnchorRect } from "./tiled-loader";
import { isWalkableIn } from "./zones";

// World tile dimensions — hardcoded to match the shipped fullMap.tmj
// (48×32, 32×32 px). Bump these in lockstep if the map shape changes.
export const MAP_COLS = 48;
export const MAP_ROWS = 32;
export const TILE_PX = 32;

let activeZone: ZoneDef | null = null;
let liveRegions: RoomRegion[] = FALLBACK_REGIONS();
let liveAnchors: Record<RoomId, RoomAnchor> = FALLBACK_ANCHOR_DETAILS();

/** Called by zones.ts once the .tmj is parsed. Wires the live zone +
 *  the room rects extracted from the map's named objects into this
 *  module's exports so callers see real data. */
export function setActiveZone(zone: ZoneDef, rooms: RoomAnchorRect[]): void {
  activeZone = zone;
  liveRegions = rooms.map((r) => ({
    id: r.id,
    colMin: r.colMin,
    colMax: r.colMax,
    rowMin: r.rowMin,
    rowMax: r.rowMax,
  }));
  // Build anchor details, layering room data on top of fallbacks so any
  // RoomId the .tmj didn't define still has *some* answer.
  const next = FALLBACK_ANCHOR_DETAILS();
  for (const r of rooms) {
    next[r.id] = {
      id: r.id,
      label: prettyLabel(r.label),
      col: r.anchor.col,
      row: r.anchor.row,
      labelCol: r.colMin,
      labelRow: Math.max(0, r.rowMin - 1),
    };
  }
  liveAnchors = next;
}

function prettyLabel(raw: string): string {
  // The .tmj names are condensed (e.g. "DataCenter", "WarRoom"). Split
  // into spaced words for the in-game label without forcing the author
  // to rename things in Tiled.
  return raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

export interface RoomAnchor {
  id: RoomId;
  label: string;
  col: number;
  row: number;
  labelCol: number;
  labelRow: number;
}

export interface RoomRegion {
  id: RoomId;
  colMin: number;
  colMax: number;
  rowMin: number;
  rowMax: number;
}

// Live exports — these are *getters* so consumers always see the
// latest data once setActiveZone runs. Importing them returns the
// live arrays; consumers should NOT cache the reference.
export const ROOM_ANCHORS = new Proxy({} as Record<RoomId, RoomAnchor>, {
  get(_, prop: string) {
    return liveAnchors[prop as RoomId];
  },
  ownKeys() {
    return Object.keys(liveAnchors);
  },
  getOwnPropertyDescriptor(_, prop: string) {
    if (prop in liveAnchors) {
      return { enumerable: true, configurable: true, value: liveAnchors[prop as RoomId] };
    }
    return undefined;
  },
});

export function getRoomRegions(): RoomRegion[] {
  return liveRegions;
}

// Backwards-compat: some callers still reference the constant. Returns
// a snapshot at call time. New code should call getRoomRegions().
export const ROOM_REGIONS = new Proxy([] as RoomRegion[], {
  get(_, prop: string | symbol) {
    return Reflect.get(liveRegions, prop, liveRegions);
  },
  ownKeys() {
    return Reflect.ownKeys(liveRegions);
  },
  getOwnPropertyDescriptor(_, prop) {
    return Reflect.getOwnPropertyDescriptor(liveRegions, prop);
  },
});

export function roomIdForCell(col: number, row: number): RoomId | null {
  for (const r of liveRegions) {
    if (col >= r.colMin && col <= r.colMax && row >= r.rowMin && row <= r.rowMax) {
      return r.id;
    }
  }
  return null;
}

export function isWalkable(col: number, row: number): boolean {
  if (!activeZone) {
    if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return false;
    return true;
  }
  return isWalkableIn(activeZone, col, row);
}

// =============================================================================
// Fallbacks (used until the .tmj loads, or for any RoomId the map
// doesn't define).
// =============================================================================

function FALLBACK_REGIONS(): RoomRegion[] {
  return [
    { id: "library",       colMin: 11, colMax: 16, rowMin: 0,  rowMax: 5  },
    { id: "desk",          colMin: 17, colMax: 23, rowMin: 1,  rowMax: 5  },
    { id: "coding_room",   colMin: 24, colMax: 30, rowMin: 1,  rowMax: 6  },
    { id: "testing_lab",   colMin: 31, colMax: 37, rowMin: 1,  rowMax: 6  },
    { id: "tool_workshop", colMin: 39, colMax: 45, rowMin: 1,  rowMax: 6  },
    { id: "meeting_room",  colMin: 29, colMax: 37, rowMin: 8,  rowMax: 12 },
    { id: "cinema",        colMin: 31, colMax: 35, rowMin: 14, rowMax: 16 },
  ];
}

function FALLBACK_ANCHOR_DETAILS(): Record<RoomId, RoomAnchor> {
  const mk = (
    id: RoomId,
    label: string,
    col: number,
    row: number,
  ): RoomAnchor => ({ id, label, col, row, labelCol: col - 2, labelRow: row - 2 });
  return {
    library:       mk("library",       "Training",     13, 2),
    desk:          mk("desk",          "Data Center",  20, 3),
    coding_room:   mk("coding_room",   "DevOps",       27, 3),
    testing_lab:   mk("testing_lab",   "Security",     34, 3),
    tool_workshop: mk("tool_workshop", "War Room",     42, 3),
    meeting_room:  mk("meeting_room",  "Meeting Room", 33, 10),
    cinema:        mk("cinema",        "Lounge",       33, 15),
  };
}
