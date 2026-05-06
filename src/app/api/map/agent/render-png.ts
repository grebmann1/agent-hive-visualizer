// Server-side PNG renderer for the map agent's screenshot tool.
//
// Composites the map's floor + decor layers into a single PNG using
// sharp. Atlas PNGs are loaded once and cached in module-level memory
// — they don't change for the lifetime of the dev server.
//
// Cells outside the building (null) render as exterior grass — same
// dirty-pastel green the in-game canvas uses. Walls / floors / decor
// come straight from the LimeZu atlases at their (col, row).

import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import manifest from "../../../../game/limezu-manifest.json";
import type { AtlasSlice } from "../../../../game/atlas";

const TILE_PX = manifest.tileSize;
const ATLAS_DIR = join(process.cwd(), "public", "assets", "limezu");

interface Tile16 {
  buffer: Buffer;
  width: number;
  height: number;
}

// LRU-ish cache: atlasKey → row-major array of per-tile RGBA buffers.
// We pre-extract every tile so each composite call is just an
// array-index lookup. Atlases are 16-pixel-tile-aligned grids.
const tileCache = new Map<string, Tile16[]>();

async function loadAtlas(atlasKey: string): Promise<Tile16[]> {
  const cached = tileCache.get(atlasKey);
  if (cached) return cached;
  const meta = manifest.atlases.find((a) => a.key === atlasKey);
  if (!meta) throw new Error(`unknown atlas '${atlasKey}'`);
  const path = join(ATLAS_DIR, meta.file);
  const raw = await readFile(path);
  // Decode the whole atlas to raw RGBA. We slice it into per-tile
  // buffers below — sharp lets us extract regions cheaply but doing
  // it once up-front is faster for repeated lookups.
  const { data, info } = await sharp(raw)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const tiles: Tile16[] = [];
  for (let r = 0; r < meta.rows; r++) {
    for (let c = 0; c < meta.cols; c++) {
      const tileBuf = Buffer.alloc(TILE_PX * TILE_PX * 4);
      for (let py = 0; py < TILE_PX; py++) {
        const srcRow = r * TILE_PX + py;
        const srcStart = (srcRow * info.width + c * TILE_PX) * 4;
        const dstStart = py * TILE_PX * 4;
        data.copy(
          tileBuf,
          dstStart,
          srcStart,
          srcStart + TILE_PX * 4,
        );
      }
      tiles.push({ buffer: tileBuf, width: TILE_PX, height: TILE_PX });
    }
  }
  tileCache.set(atlasKey, tiles);
  return tiles;
}

export interface MapForRender {
  cols: number;
  rows: number;
  floor: (AtlasSlice | null)[][];
  decor: (AtlasSlice | null)[][];
}

export async function renderMapToPng(map: MapForRender): Promise<Buffer> {
  const widthPx = map.cols * TILE_PX;
  const heightPx = map.rows * TILE_PX;

  // Background — pastel grass (matches WorldScene.drawMap GRASS_FILL).
  const GRASS_R = 0x8b;
  const GRASS_G = 0xb0;
  const GRASS_B = 0x4a;

  // Pre-resolve every atlas referenced anywhere on the map. Done in
  // one batch so we await the loads in parallel.
  const referenced = new Set<string>();
  for (const r of map.floor) for (const c of r) if (c) referenced.add(c.atlas);
  for (const r of map.decor) for (const c of r) if (c) referenced.add(c.atlas);
  const atlases = new Map<string, Tile16[]>();
  await Promise.all(
    Array.from(referenced).map(async (key) => {
      atlases.set(key, await loadAtlas(key));
    }),
  );

  const composites: sharp.OverlayOptions[] = [];
  const placeSlice = (
    slice: AtlasSlice,
    col: number,
    row: number,
  ): void => {
    const tiles = atlases.get(slice.atlas);
    if (!tiles) return;
    const meta = manifest.atlases.find((a) => a.key === slice.atlas);
    if (!meta) return;
    const spanC = slice.spanCols ?? 1;
    const spanR = slice.spanRows ?? 1;
    for (let dr = 0; dr < spanR; dr++) {
      for (let dc = 0; dc < spanC; dc++) {
        const idx = (slice.row + dr) * meta.cols + (slice.col + dc);
        const tile = tiles[idx];
        if (!tile) continue;
        composites.push({
          input: tile.buffer,
          raw: { width: TILE_PX, height: TILE_PX, channels: 4 },
          left: (col + dc) * TILE_PX,
          top: (row + dr) * TILE_PX,
        });
      }
    }
  };

  // Pass 1: floor (walls + room floors). Multi-tile slices are rare on
  // floor (it's mostly single-cell walls / floor tiles).
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const s = map.floor[r][c];
      if (s) placeSlice(s, c, r);
    }
  }
  // Pass 2: decor — drawn over the floor so furniture reads on top.
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const s = map.decor[r][c];
      if (s) placeSlice(s, c, r);
    }
  }

  return sharp({
    create: {
      width: widthPx,
      height: heightPx,
      channels: 4,
      background: { r: GRASS_R, g: GRASS_G, b: GRASS_B, alpha: 1 },
    },
  })
    .composite(composites)
    .png({ compressionLevel: 6 })
    .toBuffer();
}
