// tiled-loader.ts — fetches a Tiled map (.tmj) at runtime, normalizes its
// tileset references to paths Phaser can load, decodes gids into
// (tileset, frame) pairs, rasterizes any "Object Layer" collidable
// rectangles into a tile-coord boolean grid for pathfinding, and
// extracts NAMED ROOM OBJECTS to derive RoomId → cell anchors + regions
// directly from the authored map. Renaming or moving a room in Tiled
// updates the in-game routing without code changes.
//
// We cache the parsed map at module level so multiple imports don't
// re-fetch.
//
// Tileset path mapping: the .tmj source references PNGs by the path
// they had in the Tiled editor (under ~/Downloads). We strip the path
// and look the basename up in TILESET_PUBLIC_NAMES below — those are
// the filenames as we copied them into public/assets/maps/.

export interface TilesetMeta {
  /** Stable Phaser texture key. Derived from the public filename. */
  key: string;
  /** Image URL (under /assets/maps/). */
  imageUrl: string;
  /** First gid this tileset claims. Decoded from the .tmj. */
  firstGid: number;
  /** Number of tile columns in the source PNG. */
  columns: number;
  /** Number of tiles total. */
  tileCount: number;
  /** Tile dimensions. We assume 32×32 globally; this is the source-of-truth check. */
  tileWidth: number;
  tileHeight: number;
}

export interface TileGrid {
  width: number; // cols
  height: number; // rows
  data: number[]; // row-major; gid 0 = empty
}

export interface ObjectRect {
  /** True if `collidable` property is true. False rects are render-only or markers. */
  collidable: boolean;
  /** True if `seat` property is true (or the name is "seat"). */
  seat: boolean;
  /** Free-form name authored in Tiled. Useful for room anchors etc. */
  name: string;
  /** Pixel coordinates in the map's coord system. */
  x: number;
  y: number;
  width: number;
  height: number;
}

// Imported only as a type so RoomId stays in events/types and we don't
// drag the whole stateToRoom map into this file.
import type { RoomId } from "../events/types";

export interface RoomAnchorRect {
  /** RoomId we'll route NPCs to (mapped from the Tiled object name). */
  id: RoomId;
  /** Free-form label as authored in Tiled. */
  label: string;
  /** Inclusive tile-coord bounds derived from the Tiled rect. */
  colMin: number;
  rowMin: number;
  colMax: number;
  rowMax: number;
  /** A walkable cell near the rect's center — where an NPC parks. */
  anchor: { col: number; row: number };
}

export interface CellCoord {
  col: number;
  row: number;
}

export interface DeskRect {
  /** Inclusive cell-coord bounds derived from the rect. */
  colMin: number;
  rowMin: number;
  colMax: number;
  rowMax: number;
}

export interface ParsedMap {
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  /** Background tile layer. We currently consume only the "Background"
   *  tile layer (or the first tilelayer if "Background" is missing). */
  background: TileGrid;
  /** All tilesets in firstGid order. */
  tilesets: TilesetMeta[];
  /** All objects from object layers, flattened. */
  objects: ObjectRect[];
  /** Boolean blocking grid derived from collidable objects. true = blocked. */
  blocking: boolean[][];
  /** Named room rects → in-game RoomId, with computed walkable anchor. */
  rooms: RoomAnchorRect[];
  /** First object named "Start" — used as the exterior spawn rect. */
  startRect: ObjectRect | null;
  /** Cell coords of every object with `properties.seat === true` (or
   *  whose name is "seat" / "Seat"). NPCs claim these post-spawn. */
  seatCells: CellCoord[];
  /** Cell-coord bounds of every "Desk" object. Decor only for now;
   *  exposed for future "highlight desk in use" features. */
  deskRects: DeskRect[];
}

// Map of known PNG basenames (as referenced inside the .tmj) → public file
// they were copied to. Add entries here as you author more tilesets.
//
// As a convenience, we also accept identity matches: if the .tmj
// references "ai-office.png" directly (because it's saved inside
// public/assets/maps/), we'll map it 1:1. The explicit list still
// wins for legacy ~/Downloads paths.
const TILESET_PUBLIC_NAMES: Record<string, string> = {
  // Original Tiled-saved-from-Downloads names.
  "ChatGPT Image May 6, 2026, 08_47_02 PM.png": "ai-office-items.png",
  "ChatGPT Image May 6, 2026, 08_45_41 PM.png": "ai-office.png",
  // Public-relative names (Tiled's `../ai-office.png` after re-saving).
  "ai-office-items.png": "ai-office-items.png",
  "ai-office.png": "ai-office.png",
};

// External tileset references (Tiled's `.tsx` files) we can't fetch at
// runtime — they're outside `public/`. This map fakes the resolution by
// pointing each external `source:` filename at the inline tileset image
// + grid dimensions we already know about. Add entries when you author
// new external tilesets.
const TILESET_EXTERNAL_FALLBACK: Record<
  string,
  { publicName: string; columns: number; tileCount: number; tileWidth: number; tileHeight: number }
> = {
  "ai-office.tsx": {
    publicName: "ai-office.png",
    columns: 48,
    tileCount: 1536,
    tileWidth: 32,
    tileHeight: 32,
  },
};

const PUBLIC_MAPS_PREFIX = "/assets/maps";

// Tiled object name → in-game RoomId. Any object whose `name` matches
// one of these keys (case-insensitive) becomes a room anchor + region.
// Add new entries when you author new rooms in Tiled.
//
// Multiple Tiled names can map to the same RoomId — first one wins,
// later duplicates are ignored (they still render as decor objects).
const ROOM_NAME_TO_ID: Record<string, RoomId> = {
  // Tools / reading-ish work — Read/Grep/Glob/WebFetch.
  training: "library",
  library: "library",
  // Big-picture thinking — Think/Plan/Summarize/Failed.
  datacenter: "desk",
  "control room": "desk",
  ops: "desk",
  // Code-editing — Edit/Write/MultiEdit.
  devops: "coding_room",
  workshop: "coding_room",
  // Bash / deploy / running tools.
  warroom: "tool_workshop",
  "war room": "tool_workshop",
  kitchen: "tool_workshop",
  // Test / lab / hospital — running_tests.
  security: "testing_lab",
  "test rig": "testing_lab",
  // Sub-agent collaboration — Task tool.
  "meeting room": "meeting_room",
  meeting: "meeting_room",
  // Idle / completed / waiting.
  lounge: "cinema",
  cinema: "cinema",
};

interface RawTileset {
  firstgid: number;
  columns?: number;
  tilecount?: number;
  tilewidth?: number;
  tileheight?: number;
  image?: string;
  source?: string; // external .tsx — ignored; we resolve via firstgid clash
  name?: string;
}

interface RawTileLayer {
  type: "tilelayer";
  width: number;
  height: number;
  data: number[];
  name: string;
}

interface RawObjectLayer {
  type: "objectgroup";
  name: string;
  objects: Array<{
    name?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    properties?: Array<{ name: string; type?: string; value: unknown }>;
  }>;
}

type RawLayer = RawTileLayer | RawObjectLayer;

interface RawMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  tilesets: RawTileset[];
  layers: RawLayer[];
}

let cached: ParsedMap | null = null;
let inflight: Promise<ParsedMap> | null = null;

export function loadTiledMap(url = `${PUBLIC_MAPS_PREFIX}/fullMap.tmj`): Promise<ParsedMap> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = fetchAndParse(url).then((m) => {
    cached = m;
    inflight = null;
    return m;
  });
  return inflight;
}

async function fetchAndParse(url: string): Promise<ParsedMap> {
  // `no-store` so editing the .tmj while dev runs doesn't show a cached
  // version on next reload.
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`tiled-loader: ${url} → HTTP ${res.status}`);
  }
  const raw = (await res.json()) as RawMap;

  // Resolve tilesets. Two flavors:
  //   - inline (`image`): the PNG basename is mapped to a public file
  //     via TILESET_PUBLIC_NAMES.
  //   - external (`source` → .tsx): we can't fetch the .tsx at runtime,
  //     so we fall back to a hand-curated TILESET_EXTERNAL_FALLBACK
  //     entry that re-uses an already-public PNG with the right grid.
  const resolved: TilesetMeta[] = [];
  for (const ts of raw.tilesets) {
    if (ts.image) {
      const basename = ts.image.split(/[/\\]/).pop() ?? ts.image;
      const publicName = TILESET_PUBLIC_NAMES[basename];
      if (!publicName) {
        console.warn(
          `[tiled-loader] tileset image "${basename}" has no public mapping; skipping. Add it to TILESET_PUBLIC_NAMES.`,
        );
        continue;
      }
      resolved.push({
        key: deriveKey(publicName),
        imageUrl: `${PUBLIC_MAPS_PREFIX}/${publicName}`,
        firstGid: ts.firstgid,
        columns: ts.columns ?? 0,
        tileCount: ts.tilecount ?? 0,
        tileWidth: ts.tilewidth ?? raw.tilewidth,
        tileHeight: ts.tileheight ?? raw.tileheight,
      });
      continue;
    }
    if (ts.source) {
      const basename = ts.source.split(/[/\\]/).pop() ?? ts.source;
      const fallback = TILESET_EXTERNAL_FALLBACK[basename];
      if (!fallback) {
        console.warn(
          `[tiled-loader] external tileset "${basename}" has no fallback; skipping. Add to TILESET_EXTERNAL_FALLBACK.`,
        );
        continue;
      }
      resolved.push({
        key: deriveKey(`${basename}-${ts.firstgid}`),
        imageUrl: `${PUBLIC_MAPS_PREFIX}/${fallback.publicName}`,
        firstGid: ts.firstgid,
        columns: fallback.columns,
        tileCount: fallback.tileCount,
        tileWidth: fallback.tileWidth,
        tileHeight: fallback.tileHeight,
      });
      continue;
    }
    console.warn("[tiled-loader] tileset entry has neither image nor source; skipping");
  }
  // Sort by firstGid so resolveGid can binary-pick.
  resolved.sort((a, b) => a.firstGid - b.firstGid);

  // Tile layer named "Background" is the canvas. Falls back to the
  // first tilelayer if the canonical name is missing — keeps older
  // single-layer .tmj files working.
  const tileLayer =
    (raw.layers.find(
      (l): l is RawTileLayer => l.type === "tilelayer" && l.name === "Background",
    ) as RawTileLayer | undefined) ??
    (raw.layers.find(
      (l): l is RawTileLayer => l.type === "tilelayer",
    ) as RawTileLayer | undefined);
  if (!tileLayer) {
    throw new Error("tiled-loader: no tile layer found in map");
  }
  const background: TileGrid = {
    width: tileLayer.width,
    height: tileLayer.height,
    data: tileLayer.data,
  };

  // Flatten object layers.
  const objects: ObjectRect[] = [];
  for (const layer of raw.layers) {
    if (layer.type !== "objectgroup") continue;
    for (const o of layer.objects) {
      const props = o.properties ?? [];
      const collidable = props.some(
        (p) => p.name === "collidable" && p.value === true,
      );
      const seatProp = props.some(
        (p) => p.name === "seat" && p.value === true,
      );
      const name = o.name ?? "";
      objects.push({
        name,
        x: o.x,
        y: o.y,
        width: o.width,
        height: o.height,
        collidable,
        seat: seatProp || name.toLowerCase() === "seat",
      });
    }
  }

  const blocking = rasterizeBlocking(
    objects,
    raw.width,
    raw.height,
    raw.tilewidth,
    raw.tileheight,
  );

  const rooms = deriveRooms(
    objects,
    blocking,
    raw.width,
    raw.height,
    raw.tilewidth,
    raw.tileheight,
  );

  const startRect =
    objects.find((o) => o.name.toLowerCase() === "start") ?? null;

  const seatCells = deriveSeatCells(
    objects,
    blocking,
    raw.width,
    raw.height,
    raw.tilewidth,
    raw.tileheight,
  );

  const deskRects = deriveDeskRects(
    objects,
    raw.width,
    raw.height,
    raw.tilewidth,
    raw.tileheight,
  );

  return {
    cols: raw.width,
    rows: raw.height,
    tileWidth: raw.tilewidth,
    tileHeight: raw.tileheight,
    background,
    tilesets: resolved,
    objects,
    blocking,
    rooms,
    startRect,
    seatCells,
    deskRects,
  };
}

/** Convert each `seat: true` object to a single tile cell (the cell
 *  containing the rect's center). Drops out-of-bounds or blocked
 *  cells, and dedupes — no two seats can occupy the same cell. */
function deriveSeatCells(
  objects: ObjectRect[],
  blocking: boolean[][],
  cols: number,
  rows: number,
  tw: number,
  th: number,
): CellCoord[] {
  const out: CellCoord[] = [];
  const seen = new Set<string>();
  for (const obj of objects) {
    if (!obj.seat) continue;
    const cx = obj.x + obj.width / 2;
    const cy = obj.y + obj.height / 2;
    const col = Math.floor(cx / tw);
    const row = Math.floor(cy / th);
    if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
    if (blocking[row][col]) continue;
    const key = `${col},${row}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ col, row });
  }
  return out;
}

/** Convert each `Desk` object to its cell-coord bounds. Decor only. */
function deriveDeskRects(
  objects: ObjectRect[],
  cols: number,
  rows: number,
  tw: number,
  th: number,
): DeskRect[] {
  const out: DeskRect[] = [];
  for (const obj of objects) {
    if (obj.name.toLowerCase() !== "desk") continue;
    const colMin = Math.max(0, Math.floor(obj.x / tw));
    const colMax = Math.min(cols - 1, Math.floor((obj.x + obj.width) / tw));
    const rowMin = Math.max(0, Math.floor(obj.y / th));
    const rowMax = Math.min(rows - 1, Math.floor((obj.y + obj.height) / th));
    out.push({ colMin, colMax, rowMin, rowMax });
  }
  return out;
}

/** Derive RoomAnchorRects from named objects whose names match
 *  ROOM_NAME_TO_ID. The anchor is a walkable cell near the rect's
 *  center; we spiral outward up to 6 cells if the center itself is
 *  blocked. Duplicate names map to the same RoomId — first wins. */
function deriveRooms(
  objects: ObjectRect[],
  blocking: boolean[][],
  cols: number,
  rows: number,
  tw: number,
  th: number,
): RoomAnchorRect[] {
  const out: RoomAnchorRect[] = [];
  const claimed = new Set<RoomId>();
  for (const obj of objects) {
    const id = ROOM_NAME_TO_ID[obj.name.toLowerCase()];
    if (!id) continue;
    if (claimed.has(id)) continue;
    claimed.add(id);
    const colMin = Math.max(0, Math.floor(obj.x / tw));
    const colMax = Math.min(cols - 1, Math.floor((obj.x + obj.width) / tw));
    const rowMin = Math.max(0, Math.floor(obj.y / th));
    const rowMax = Math.min(rows - 1, Math.floor((obj.y + obj.height) / th));
    const cc = Math.floor((colMin + colMax) / 2);
    const cr = Math.floor((rowMin + rowMax) / 2);
    const anchor = findWalkable(blocking, cc, cr, colMin, colMax, rowMin, rowMax);
    out.push({ id, label: obj.name, colMin, colMax, rowMin, rowMax, anchor });
  }
  return out;
}

export function findWalkableInRect(
  blocking: boolean[][],
  colMin: number,
  rowMin: number,
  colMax: number,
  rowMax: number,
): { col: number; row: number } | null {
  const cc = Math.floor((colMin + colMax) / 2);
  const cr = Math.floor((rowMin + rowMax) / 2);
  return findWalkable(blocking, cc, cr, colMin, colMax, rowMin, rowMax);
}

function findWalkable(
  blocking: boolean[][],
  startCol: number,
  startRow: number,
  colMin: number,
  colMax: number,
  rowMin: number,
  rowMax: number,
): { col: number; row: number } {
  if (!blocking[startRow]?.[startCol]) {
    return { col: startCol, row: startRow };
  }
  for (let d = 1; d < 8; d++) {
    for (let dr = -d; dr <= d; dr++) {
      for (let dc = -d; dc <= d; dc++) {
        const r = startRow + dr;
        const c = startCol + dc;
        if (r < rowMin || r > rowMax || c < colMin || c > colMax) continue;
        if (!blocking[r]?.[c]) return { col: c, row: r };
      }
    }
  }
  // Fallback: return the start cell even if blocked — better than
  // throwing.
  return { col: startCol, row: startRow };
}

function deriveKey(filename: string): string {
  return filename
    .replace(/\.png$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
}

/** Mark every tile that overlaps a `collidable: true` object rect.
 *  Rects in Tiled are pixel-aligned but not tile-aligned — we use
 *  any-overlap-blocks (≥1px). */
function rasterizeBlocking(
  objects: ObjectRect[],
  cols: number,
  rows: number,
  tw: number,
  th: number,
): boolean[][] {
  const grid: boolean[][] = Array.from({ length: rows }, () =>
    new Array(cols).fill(false),
  );
  for (const obj of objects) {
    if (!obj.collidable) continue;
    const colMin = Math.max(0, Math.floor(obj.x / tw));
    const colMax = Math.min(cols - 1, Math.floor((obj.x + obj.width - 0.001) / tw));
    const rowMin = Math.max(0, Math.floor(obj.y / th));
    const rowMax = Math.min(rows - 1, Math.floor((obj.y + obj.height - 0.001) / th));
    for (let r = rowMin; r <= rowMax; r++) {
      for (let c = colMin; c <= colMax; c++) {
        grid[r][c] = true;
      }
    }
  }
  return grid;
}

/** Decode a raw gid into (tilesetKey, frame). gid 0 = empty cell. */
export function resolveGid(
  gid: number,
  tilesets: TilesetMeta[],
): { key: string; frame: number } | null {
  if (gid === 0) return null;
  // Strip Tiled's flip/rotate flags (top 4 bits).
  const cleanGid = gid & 0x1fffffff;
  // Find the tileset whose firstGid is the largest <= cleanGid.
  let chosen: TilesetMeta | null = null;
  for (const ts of tilesets) {
    if (ts.firstGid <= cleanGid) chosen = ts;
    else break;
  }
  if (!chosen) return null;
  const localId = cleanGid - chosen.firstGid;
  if (localId < 0 || localId >= chosen.tileCount) return null;
  return { key: chosen.key, frame: localId };
}
