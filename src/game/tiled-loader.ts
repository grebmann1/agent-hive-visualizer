// tiled-loader.ts — fetches a Tiled map (.tmj) at runtime, normalizes its
// tileset references to paths Phaser can load, decodes gids into
// (tileset, frame) pairs, and rasterizes any "Object Layer" collidable
// rectangles into a tile-coord boolean grid for pathfinding.
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
  /** Free-form name authored in Tiled. Useful for room anchors etc. */
  name: string;
  /** Pixel coordinates in the map's coord system. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ParsedMap {
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  /** Background tile layer. We currently consume only the first tile layer. */
  background: TileGrid;
  /** All tilesets in firstGid order. */
  tilesets: TilesetMeta[];
  /** All objects from object layers, flattened. */
  objects: ObjectRect[];
  /** Boolean blocking grid derived from collidable objects. true = blocked. */
  blocking: boolean[][];
}

// Map of known PNG basenames (as referenced inside the .tmj) → public file
// they were copied to. Add entries here as you author more tilesets.
const TILESET_PUBLIC_NAMES: Record<string, string> = {
  "ChatGPT Image May 6, 2026, 08_47_02 PM.png": "ai-office-items.png",
  "ChatGPT Image May 6, 2026, 08_45_41 PM.png": "ai-office.png",
};

const PUBLIC_MAPS_PREFIX = "/assets/maps";

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
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`tiled-loader: ${url} → HTTP ${res.status}`);
  }
  const raw = (await res.json()) as RawMap;

  // Resolve tilesets — only those with a direct `image` are usable in the
  // browser. The .tmj also has a `source: "..."` external tileset entry
  // pointing at a .tsx file we can't follow; merge it with whichever
  // inline tileset shares its basename.
  const resolved: TilesetMeta[] = [];
  for (const ts of raw.tilesets) {
    if (!ts.image) continue;
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
  }
  // Sort by firstGid so resolveGid can binary-pick.
  resolved.sort((a, b) => a.firstGid - b.firstGid);

  // First tile layer is the canvas. (We could merge multiple tile layers
  // later if needed — the current map ships one.)
  const tileLayer = raw.layers.find(
    (l): l is RawTileLayer => l.type === "tilelayer",
  );
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
      objects.push({
        name: o.name ?? "",
        x: o.x,
        y: o.y,
        width: o.width,
        height: o.height,
        collidable,
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

  return {
    cols: raw.width,
    rows: raw.height,
    tileWidth: raw.tilewidth,
    tileHeight: raw.tileheight,
    background,
    tilesets: resolved,
    objects,
    blocking,
  };
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
