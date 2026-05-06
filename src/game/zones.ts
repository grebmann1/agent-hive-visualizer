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

// Hand-picked anchors for the current 48×32 fullMap. Update these to
// match the actual room layout once we eyeball the rendered map.
const DEFAULT_ANCHORS: Partial<Record<RoomId, { col: number; row: number }>> = {
  library: { col: 8, row: 8 },
  coding_room: { col: 18, row: 8 },
  desk: { col: 28, row: 8 },
  cinema: { col: 38, row: 8 },
  tool_workshop: { col: 8, row: 22 },
  meeting_room: { col: 18, row: 22 },
  testing_lab: { col: 28, row: 22 },
};

// South-edge entry/exit. Defaults to roughly the middle of the bottom
// row; if the authored map's front door is elsewhere, override here.
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
    anchors: DEFAULT_ANCHORS,
  };
  cachedBundle = { zone, parsed };
  // Hand the active zone to rooms.ts so isWalkable() picks up the
  // collision grid instead of falling back to "everything walkable".
  setActiveZone(zone);
  return cachedBundle;
}

export function isWalkableIn(zone: ZoneDef, col: number, row: number): boolean {
  if (col < 0 || col >= zone.cols || row < 0 || row >= zone.rows) return false;
  return !zone.blocking[row][col];
}
