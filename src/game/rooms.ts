// rooms.ts — backward-compat shim.
// The canonical world data lives in `zones.ts` (multi-zone). This file keeps
// the old exports (MAP_COLS, MAP_ROWS, FLOOR_LAYER, DECOR_LAYER, ROOM_ANCHORS,
// isWalkable) wired to the **interior** zone so existing callers that haven't
// been ported to zones yet keep working.
//
// New code should import from `zones.ts` directly.

import type { RoomId } from "../events/types";
import { INTERIOR_ZONE, isWalkableIn } from "./zones";

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

// Room labels were re-themed in v1.1 to match the actual Kenney Tiny Dungeon
// art (fantasy/dungeon, not office). The underlying RoomId codes stay the
// same so all event-routing / state-to-room logic keeps working unchanged.
export const ROOM_ANCHORS: Record<RoomId, RoomAnchor> = {
  coding_room: {
    id: "coding_room",
    label: "IDE",
    col: INTERIOR_ZONE.anchors.coding_room?.col ?? 4,
    row: INTERIOR_ZONE.anchors.coding_room?.row ?? 4,
    labelCol: 1,
    labelRow: 1,
  },
  desk: {
    id: "desk",
    label: "Ops Center",
    col: INTERIOR_ZONE.anchors.desk?.col ?? 11,
    row: INTERIOR_ZONE.anchors.desk?.row ?? 4,
    labelCol: 9,
    labelRow: 1,
  },
  library: {
    id: "library",
    label: "Knowledge Base",
    col: INTERIOR_ZONE.anchors.library?.col ?? 19,
    row: INTERIOR_ZONE.anchors.library?.row ?? 4,
    labelCol: 16,
    labelRow: 1,
  },
  tool_workshop: {
    id: "tool_workshop",
    label: "Build Bay",
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
};

export function isWalkable(col: number, row: number): boolean {
  return isWalkableIn(INTERIOR_ZONE, col, row);
}
