// rooms.ts — labels + region rectangles + walkability shim.
//
// The canonical world geometry lives in `zones.ts`, which is async-loaded
// from the Tiled `.tmj` at scene start. Until the load finishes, this
// shim falls back to a "walkable everywhere" answer so pathfinding
// helpers don't crash on early calls. Once `zones.ts` resolves, it
// installs the live ZoneDef via `setActiveZone()`.

import type { RoomId } from "../events/types";
import type { ZoneDef } from "./zones";
import { isWalkableIn } from "./zones";

// World tile dimensions — hardcoded to match the shipped fullMap.tmj
// (48×32, 32×32 px). Bump these in lockstep if the map shape changes.
export const MAP_COLS = 48;
export const MAP_ROWS = 32;
export const TILE_PX = 32;

let activeZone: ZoneDef | null = null;
export function setActiveZone(zone: ZoneDef): void {
  activeZone = zone;
}

export interface RoomAnchor {
  id: RoomId;
  label: string;
  col: number;
  row: number;
  labelCol: number;
  labelRow: number;
}

// Mixed naming scheme: cozy labels for tool-centric rooms (Library,
// Workshop, Kitchen, Lounge) plus techy labels for meta-work rooms
// (Control Room, Test Rig). Coordinates are first-pass guesses for the
// 48×32 fullMap; refine once we eyeball the rendered map.
export const ROOM_ANCHORS: Record<RoomId, RoomAnchor> = {
  library:       { id: "library",       label: "Library",      col: 8,  row: 8,  labelCol: 4,  labelRow: 5  },
  coding_room:   { id: "coding_room",   label: "Workshop",     col: 18, row: 8,  labelCol: 14, labelRow: 5  },
  desk:          { id: "desk",          label: "Control Room", col: 28, row: 8,  labelCol: 24, labelRow: 5  },
  cinema:        { id: "cinema",        label: "Lounge",       col: 38, row: 8,  labelCol: 34, labelRow: 5  },
  tool_workshop: { id: "tool_workshop", label: "Kitchen",      col: 8,  row: 22, labelCol: 4,  labelRow: 19 },
  meeting_room:  { id: "meeting_room",  label: "Meeting Room", col: 18, row: 22, labelCol: 14, labelRow: 19 },
  testing_lab:   { id: "testing_lab",   label: "Test Rig",     col: 28, row: 22, labelCol: 24, labelRow: 19 },
};

export interface RoomRegion {
  id: RoomId;
  colMin: number;
  colMax: number;
  rowMin: number;
  rowMax: number;
}

// First-pass region rectangles for the new map. Adjust once the map's
// layout is set in stone.
export const ROOM_REGIONS: RoomRegion[] = [
  { id: "library",       colMin: 4,  colMax: 12, rowMin: 5,  rowMax: 12 },
  { id: "coding_room",   colMin: 14, colMax: 22, rowMin: 5,  rowMax: 12 },
  { id: "desk",          colMin: 24, colMax: 32, rowMin: 5,  rowMax: 12 },
  { id: "cinema",        colMin: 34, colMax: 44, rowMin: 5,  rowMax: 12 },
  { id: "tool_workshop", colMin: 4,  colMax: 12, rowMin: 19, rowMax: 26 },
  { id: "meeting_room",  colMin: 14, colMax: 22, rowMin: 19, rowMax: 26 },
  { id: "testing_lab",   colMin: 24, colMax: 32, rowMin: 19, rowMax: 26 },
];

export function roomIdForCell(col: number, row: number): RoomId | null {
  for (const r of ROOM_REGIONS) {
    if (col >= r.colMin && col <= r.colMax && row >= r.rowMin && row <= r.rowMax) {
      return r.id;
    }
  }
  return null;
}

export function isWalkable(col: number, row: number): boolean {
  if (!activeZone) {
    // Map hasn't loaded yet. Treat in-bounds cells as walkable so any
    // queued pathfind call returns *something* sensible. Out-of-bounds
    // is always blocked.
    if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return false;
    return true;
  }
  return isWalkableIn(activeZone, col, row);
}
