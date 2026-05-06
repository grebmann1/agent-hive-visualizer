// zones.ts — adapter from the Tiled `.tmj` pipeline to the in-game zone
// abstraction. The world is now a single tile-layer (gid grid) plus an
// object-derived blocking grid. Walkability is read from the blocking
// grid; rendering needs the tilesets list.

import type { RoomId } from "../events/types";
import { loadTiledMap, type ParsedMap, type TilesetMeta } from "./tiled-loader";
import { setActiveZone } from "./rooms";

export type ZoneId = "interior";

export interface ZoneDef {
  id: ZoneId;
  name: string;
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  /** Single tile layer: row-major flat array of gids (0 = empty). */
  gids: number[];
  /** Tilesets in firstGid order — pass to resolveGid. */
  tilesets: TilesetMeta[];
  /** Boolean grid; true = blocked. Indexed [row][col]. */
  blocking: boolean[][];
  /** Cell-coord targets for each in-game RoomId. */
  anchors: Partial<Record<RoomId, { col: number; row: number }>>;
}

// Hard fallback anchors for any RoomId the authored map doesn't define.
// In practice the .tmj should name rooms (Training, DataCenter, DevOps,
// Security, WarRoom, "Meeting Room", Lounge) and the loader fills in
// real cells. These constants only matter if you remove a room from
// Tiled — keeps the routing from crashing.
const FALLBACK_ANCHORS: Partial<Record<RoomId, { col: number; row: number }>> = {
  library: { col: 13, row: 2 },
  coding_room: { col: 27, row: 3 },
  desk: { col: 20, row: 3 },
  cinema: { col: 33, row: 15 },
  tool_workshop: { col: 42, row: 3 },
  meeting_room: { col: 33, row: 10 },
  testing_lab: { col: 34, row: 3 },
};

// South-edge entry/exit. Updated at load time to land on a walkable
// cell near the bottom edge.
let exteriorAnchors = {
  entry: { col: 24, row: 31 },
  exit: { col: 24, row: 31 },
};

export const EXTERIOR_ANCHORS = exteriorAnchors;

export function setExteriorAnchors(next: typeof exteriorAnchors): void {
  exteriorAnchors = next;
  Object.assign(EXTERIOR_ANCHORS, next);
}

export interface InteriorZoneBundle {
  zone: ZoneDef;
  parsed: ParsedMap;
}

let cachedBundle: InteriorZoneBundle | null = null;

export async function loadInteriorZone(): Promise<InteriorZoneBundle> {
  if (cachedBundle) return cachedBundle;
  const parsed = await loadTiledMap();
  // Anchors: prefer the .tmj-derived rooms; fall back to FALLBACK_ANCHORS
  // for any RoomId the authored map didn't define.
  const anchors: Partial<Record<RoomId, { col: number; row: number }>> = {
    ...FALLBACK_ANCHORS,
  };
  for (const room of parsed.rooms) {
    anchors[room.id] = room.anchor;
  }
  // Refresh exterior anchor to a walkable cell near the south edge.
  setExteriorAnchors(pickExteriorAnchor(parsed));
  const zone: ZoneDef = {
    id: "interior",
    name: "Agent Ops",
    cols: parsed.cols,
    rows: parsed.rows,
    tileWidth: parsed.tileWidth,
    tileHeight: parsed.tileHeight,
    gids: parsed.background.data,
    tilesets: parsed.tilesets,
    blocking: parsed.blocking,
    anchors,
  };
  cachedBundle = { zone, parsed };
  // Hand the active zone + the named rooms extracted from the .tmj to
  // rooms.ts so isWalkable() / ROOM_ANCHORS / ROOM_REGIONS pick up the
  // live data.
  setActiveZone(zone, parsed.rooms);
  return cachedBundle;
}

function pickExteriorAnchor(parsed: {
  cols: number;
  rows: number;
  blocking: boolean[][];
}): { entry: { col: number; row: number }; exit: { col: number; row: number } } {
  // Walk the bottom row left→right looking for the first walkable cell;
  // fall back to col 24 if everything's blocked.
  const bottomRow = parsed.rows - 1;
  for (let c = 0; c < parsed.cols; c++) {
    if (!parsed.blocking[bottomRow][c]) {
      return {
        entry: { col: c, row: bottomRow },
        exit: { col: c, row: bottomRow },
      };
    }
  }
  return {
    entry: { col: 24, row: bottomRow },
    exit: { col: 24, row: bottomRow },
  };
}

export function isWalkableIn(zone: ZoneDef, col: number, row: number): boolean {
  if (col < 0 || col >= zone.cols || row < 0 || row >= zone.rows) return false;
  return !zone.blocking[row][col];
}
