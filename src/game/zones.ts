// zones.ts — adapter from the Tiled `.tmj` pipeline to the in-game zone
// abstraction. The world is now a single tile-layer (gid grid) plus an
// object-derived blocking grid. Walkability is read from the blocking
// grid; rendering needs the tilesets list.

import type { RoomId } from "../events/types";
import {
  findWalkableInRect,
  loadTiledMap,
  type ParsedMap,
  type TilesetMeta,
} from "./tiled-loader";
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
  // Exterior anchor: prefer the authored "Start" rect from the .tmj
  // (this is the spawn area for new dynamic NPCs). Fall back to the
  // largest-component bottom-row picker only if Start is missing —
  // log so the user notices.
  setExteriorAnchors(pickStartOrFallback(parsed));

  // Reachability check: warn (in dev) for any room whose anchor isn't
  // in the same connected component as the entry. Tiled-side fix: cut
  // a 1-cell gap in the Collision wall between the corridor and that
  // room.
  if (typeof window !== "undefined") {
    const components = floodComponents(parsed);
    const entryId = components.componentIdAt(
      EXTERIOR_ANCHORS.entry.col,
      EXTERIOR_ANCHORS.entry.row,
    );
    const unreachable: string[] = [];
    for (const room of parsed.rooms) {
      const id = components.componentIdAt(room.anchor.col, room.anchor.row);
      if (id === null || id !== entryId) {
        unreachable.push(`${room.label} (${room.anchor.col},${room.anchor.row})`);
      }
    }
    if (unreachable.length > 0) {
      console.warn(
        `[zones] ${unreachable.length} rooms unreachable from entry — agents will stay where they spawn.\n` +
          `  Cut a 1-cell gap in the Collision layer between the corridor and:\n` +
          unreachable.map((r) => `    • ${r}`).join("\n"),
      );
    }
  }
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

function pickStartOrFallback(parsed: ParsedMap): {
  entry: { col: number; row: number };
  exit: { col: number; row: number };
} {
  if (parsed.startRect) {
    const { x, y, width, height } = parsed.startRect;
    const colMin = Math.max(0, Math.floor(x / parsed.tileWidth));
    const colMax = Math.min(
      parsed.cols - 1,
      Math.floor((x + width) / parsed.tileWidth),
    );
    const rowMin = Math.max(0, Math.floor(y / parsed.tileHeight));
    const rowMax = Math.min(
      parsed.rows - 1,
      Math.floor((y + height) / parsed.tileHeight),
    );
    const cell =
      findWalkableInRect(parsed.blocking, colMin, rowMin, colMax, rowMax) ?? {
        col: Math.floor((colMin + colMax) / 2),
        row: Math.floor((rowMin + rowMax) / 2),
      };
    return { entry: cell, exit: cell };
  }
  if (typeof window !== "undefined") {
    console.warn(
      `[zones] no "Start" object in the .tmj — falling back to bottom-row spawn. Add a Start rect in Tiled to control where dynamic NPCs appear.`,
    );
  }
  return pickExteriorAnchor(parsed);
}

function pickExteriorAnchor(parsed: {
  cols: number;
  rows: number;
  blocking: boolean[][];
}): { entry: { col: number; row: number }; exit: { col: number; row: number } } {
  // Pick the bottom-row cell that connects to the largest walkable
  // component — that's where the most of the map is reachable from,
  // so dynamic NPCs spawn somewhere they can actually walk to rooms.
  const bottomRow = parsed.rows - 1;
  const components = floodComponents(parsed);
  let best: { col: number; size: number } | null = null;
  for (let c = 0; c < parsed.cols; c++) {
    if (parsed.blocking[bottomRow][c]) continue;
    const compSize = components.sizeOf(c, bottomRow);
    if (!best || compSize > best.size) best = { col: c, size: compSize };
  }
  if (best) {
    return {
      entry: { col: best.col, row: bottomRow },
      exit: { col: best.col, row: bottomRow },
    };
  }
  return {
    entry: { col: Math.floor(parsed.cols / 2), row: bottomRow },
    exit: { col: Math.floor(parsed.cols / 2), row: bottomRow },
  };
}

interface ComponentIndex {
  sizeOf: (col: number, row: number) => number;
  largestComponent: () => Set<number>;
  componentSizes: () => Map<number, number>;
  componentIdAt: (col: number, row: number) => number | null;
}

function floodComponents(parsed: {
  cols: number;
  rows: number;
  blocking: boolean[][];
}): ComponentIndex {
  const W = parsed.cols;
  const H = parsed.rows;
  const ids = new Int32Array(W * H).fill(-1);
  const sizes = new Map<number, number>();
  let next = 0;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (ids[r * W + c] !== -1 || parsed.blocking[r][c]) continue;
      const id = next++;
      const stack: Array<[number, number]> = [[c, r]];
      ids[r * W + c] = id;
      let count = 0;
      while (stack.length) {
        const [cc, cr] = stack.pop()!;
        count++;
        for (const [dc, dr] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nc = cc + dc;
          const nr = cr + dr;
          if (nc < 0 || nc >= W || nr < 0 || nr >= H) continue;
          if (ids[nr * W + nc] !== -1) continue;
          if (parsed.blocking[nr][nc]) continue;
          ids[nr * W + nc] = id;
          stack.push([nc, nr]);
        }
      }
      sizes.set(id, count);
    }
  }
  return {
    sizeOf: (col, row) => {
      const id = ids[row * W + col];
      return id === -1 ? 0 : sizes.get(id) ?? 0;
    },
    componentIdAt: (col, row) => {
      const id = ids[row * W + col];
      return id === -1 ? null : id;
    },
    largestComponent: () => {
      let bestId = -1;
      let bestSize = 0;
      for (const [id, sz] of sizes) {
        if (sz > bestSize) {
          bestSize = sz;
          bestId = id;
        }
      }
      const out = new Set<number>();
      if (bestId === -1) return out;
      for (let i = 0; i < ids.length; i++) if (ids[i] === bestId) out.add(i);
      return out;
    },
    componentSizes: () => sizes,
  };
}

export function isWalkableIn(zone: ZoneDef, col: number, row: number): boolean {
  if (col < 0 || col >= zone.cols || row < 0 || row >= zone.rows) return false;
  return !zone.blocking[row][col];
}
