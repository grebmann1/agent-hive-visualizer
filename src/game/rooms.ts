// rooms.ts — labels + region rectangles + walkability shim.
// The canonical world geometry lives in `zones.ts` (LimeZu pipeline).

import type { RoomId } from "../events/types";
import { INTERIOR_ZONE, isWalkableIn } from "./zones";

export const MAP_COLS = INTERIOR_ZONE.cols;
export const MAP_ROWS = INTERIOR_ZONE.rows;
export const TILE_PX = 16;

// New code that needs the floor/decor layers should import them
// directly from zones.ts (`INTERIOR_ZONE.floor` / `.decor`) rather
// than going through this file.
export const FLOOR_LAYER = INTERIOR_ZONE.floor;
export const DECOR_LAYER = INTERIOR_ZONE.decor;

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
// (Control Room, Test Rig). Underlying RoomId codes stay stable so
// event-routing + state-to-room logic is untouched.
export const ROOM_ANCHORS: Record<RoomId, RoomAnchor> = {
  library: {
    id: "library",
    label: "Library",
    col: INTERIOR_ZONE.anchors.library?.col ?? 5,
    row: INTERIOR_ZONE.anchors.library?.row ?? 6,
    labelCol: 2,
    labelRow: 4,
  },
  coding_room: {
    id: "coding_room",
    label: "Workshop",
    col: INTERIOR_ZONE.anchors.coding_room?.col ?? 11,
    row: INTERIOR_ZONE.anchors.coding_room?.row ?? 6,
    labelCol: 10,
    labelRow: 4,
  },
  desk: {
    id: "desk",
    label: "Control Room",
    col: INTERIOR_ZONE.anchors.desk?.col ?? 17,
    row: INTERIOR_ZONE.anchors.desk?.row ?? 6,
    labelCol: 14,
    labelRow: 4,
  },
  cinema: {
    id: "cinema",
    label: "Lounge",
    col: INTERIOR_ZONE.anchors.cinema?.col ?? 25,
    row: INTERIOR_ZONE.anchors.cinema?.row ?? 6,
    labelCol: 22,
    labelRow: 4,
  },
  tool_workshop: {
    id: "tool_workshop",
    label: "Kitchen",
    col: INTERIOR_ZONE.anchors.tool_workshop?.col ?? 5,
    row: INTERIOR_ZONE.anchors.tool_workshop?.row ?? 16,
    labelCol: 2,
    labelRow: 13,
  },
  meeting_room: {
    id: "meeting_room",
    label: "Meeting Room",
    col: INTERIOR_ZONE.anchors.meeting_room?.col ?? 11,
    row: INTERIOR_ZONE.anchors.meeting_room?.row ?? 16,
    labelCol: 10,
    labelRow: 13,
  },
  testing_lab: {
    id: "testing_lab",
    label: "Test Rig",
    col: INTERIOR_ZONE.anchors.testing_lab?.col ?? 17,
    row: INTERIOR_ZONE.anchors.testing_lab?.row ?? 16,
    labelCol: 14,
    labelRow: 13,
  },
};

// Room regions used by overhead UI (room labels, hit-zones for chips).
// Inclusive bounds in tile coordinates of the full map. Match the
// regions in zones.ts so the floor renderer agrees with the labeller.
export interface RoomRegion {
  id: RoomId;
  colMin: number;
  colMax: number;
  rowMin: number;
  rowMax: number;
}

export const ROOM_REGIONS: RoomRegion[] = [
  { id: "library",       colMin: 2,  colMax: 9,  rowMin: 4,  rowMax: 9  },
  { id: "coding_room",   colMin: 10, colMax: 13, rowMin: 4,  rowMax: 9  },
  { id: "desk",          colMin: 14, colMax: 21, rowMin: 4,  rowMax: 9  },
  { id: "cinema",        colMin: 22, colMax: 29, rowMin: 4,  rowMax: 9  },
  { id: "tool_workshop", colMin: 2,  colMax: 9,  rowMin: 13, rowMax: 18 },
  { id: "meeting_room",  colMin: 10, colMax: 13, rowMin: 13, rowMax: 18 },
  { id: "testing_lab",   colMin: 14, colMax: 21, rowMin: 13, rowMax: 18 },
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
  return isWalkableIn(INTERIOR_ZONE, col, row);
}
