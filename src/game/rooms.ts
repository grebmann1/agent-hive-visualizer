// rooms.ts — backward-compat shim.
// The canonical world data lives in `zones.ts` (multi-zone). This file keeps
// the old exports (MAP_COLS, MAP_ROWS, FLOOR_LAYER, DECOR_LAYER, ROOM_ANCHORS,
// isWalkable) wired to the **interior** zone so existing callers that haven't
// been ported to zones yet keep working.
//
// New code should import from `zones.ts` directly.

import type { RoomId } from "../events/types";
import { INTERIOR_ZONE, ROW_SHIFT_FROM_INTERIOR, isWalkableIn } from "./zones";

export const MAP_COLS = INTERIOR_ZONE.cols;
export const MAP_ROWS = INTERIOR_ZONE.rows;
export const TILE_PX = 16;

export const FLOOR_LAYER = INTERIOR_ZONE.layout;
export const DECOR_LAYER = INTERIOR_ZONE.decor;

export interface RoomAnchor {
  id: RoomId;
  label: string;
  col: number;
  row: number;
  labelCol: number;
  labelRow: number;
}

// Mixed naming scheme: cozy labels for tool-centric rooms (Library, Workshop,
// Kitchen, Lounge) plus techy labels for meta-work rooms (Control Room, Test
// Rig). Underlying RoomId codes stay stable so event-routing + state-to-room
// logic is untouched.
export const ROOM_ANCHORS: Record<RoomId, RoomAnchor> = {
  coding_room: {
    id: "coding_room",
    label: "Workshop",
    col: INTERIOR_ZONE.anchors.coding_room?.col ?? 4,
    row: INTERIOR_ZONE.anchors.coding_room?.row ?? 4,
    labelCol: 1,
    labelRow: 1,
  },
  desk: {
    id: "desk",
    label: "Control Room",
    col: INTERIOR_ZONE.anchors.desk?.col ?? 11,
    row: INTERIOR_ZONE.anchors.desk?.row ?? 4,
    labelCol: 9,
    labelRow: 1,
  },
  library: {
    id: "library",
    label: "Library",
    col: INTERIOR_ZONE.anchors.library?.col ?? 19,
    row: INTERIOR_ZONE.anchors.library?.row ?? 4,
    labelCol: 16,
    labelRow: 1,
  },
  tool_workshop: {
    id: "tool_workshop",
    label: "Kitchen",
    col: INTERIOR_ZONE.anchors.tool_workshop?.col ?? 5,
    row: INTERIOR_ZONE.anchors.tool_workshop?.row ?? 12,
    labelCol: 1,
    labelRow: 8,
  },
  testing_lab: {
    id: "testing_lab",
    label: "Test Rig",
    col: INTERIOR_ZONE.anchors.testing_lab?.col ?? 17,
    row: INTERIOR_ZONE.anchors.testing_lab?.row ?? 12,
    labelCol: 12,
    labelRow: 8,
  },
  cinema: {
    id: "cinema",
    label: "Lounge",
    col: INTERIOR_ZONE.anchors.cinema?.col ?? 11,
    row: INTERIOR_ZONE.anchors.cinema?.row ?? 19,
    labelCol: 10,
    labelRow: 16,
  },
  meeting_room: {
    id: "meeting_room",
    label: "Meeting Room",
    col: INTERIOR_ZONE.anchors.meeting_room?.col ?? 13,
    row: INTERIOR_ZONE.anchors.meeting_room?.row ?? 8,
    labelCol: 12,
    labelRow: 7,
  },
};

// Rectangular regions each room owns for floor-tinting. Inclusive bounds in
// tile coordinates. Aisle rows 6 + 13 and the central corridor (col 11,
// rows 7-12) sit between regions and stay untinted (neutral).
//
// Chosen by eye from the layout in zones.ts: each top-half cluster spans
// ~8 cols × 5 rows around its anchor; bottom-half is similar; Lounge
// occupies rows 16-20.
export interface RoomRegion {
  id: RoomId;
  colMin: number;
  colMax: number;
  rowMin: number;
  rowMax: number;
}

// Regions are authored in interior-relative row indices and shifted at
// lookup time so growing the exterior band doesn't force a rewrite.
const INTERIOR_ROOM_REGIONS: RoomRegion[] = [
  // Top half — split at col 10 / col 14 so Ops stays central
  { id: "coding_room", colMin: 1,  colMax: 9,  rowMin: 1,  rowMax: 5  },
  { id: "desk",        colMin: 10, colMax: 14, rowMin: 1,  rowMax: 5  },
  { id: "library",     colMin: 15, colMax: 22, rowMin: 1,  rowMax: 5  },
  // Bottom half (below main aisle row 6, above partition row 15)
  { id: "tool_workshop", colMin: 1,  colMax: 12, rowMin: 7,  rowMax: 14 },
  // Meeting Room — small pocket carved out of testing_lab's west side. Put
  // this BEFORE testing_lab in the array so roomIdForCell prefers it.
  { id: "meeting_room", colMin: 13, colMax: 15, rowMin: 7,  rowMax: 10 },
  { id: "testing_lab",  colMin: 13, colMax: 22, rowMin: 7,  rowMax: 14 },
  // Lounge occupies the whole bottom band
  { id: "cinema", colMin: 1, colMax: 22, rowMin: 16, rowMax: 20 },
];

export const ROOM_REGIONS: RoomRegion[] = INTERIOR_ROOM_REGIONS.map((r) => ({
  ...r,
  rowMin: r.rowMin + ROW_SHIFT_FROM_INTERIOR,
  rowMax: r.rowMax + ROW_SHIFT_FROM_INTERIOR,
}));

// Lookup: which room owns this cell (or null for aisle/wall/exterior).
// O(regions) per call; regions are small so no need for a lookup grid.
export function roomIdForCell(col: number, row: number): RoomId | null {
  for (const r of ROOM_REGIONS) {
    if (
      col >= r.colMin && col <= r.colMax &&
      row >= r.rowMin && row <= r.rowMax
    ) {
      return r.id;
    }
  }
  return null;
}

export function isWalkable(col: number, row: number): boolean {
  return isWalkableIn(INTERIOR_ZONE, col, row);
}
