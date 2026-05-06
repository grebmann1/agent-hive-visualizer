// atlas.ts — generic multi-atlas loader for the LimeZu pipeline.
//
// `AtlasSlice` describes a tile by atlas key + grid coords. The renderer
// looks up the manifest to convert (col, row) into a Phaser frame index.
// Multi-tile sprites (e.g. a 1×2 fridge) carry spanCols/spanRows so a
// single AtlasSlice can describe the whole sprite.

import type Phaser from "phaser";
import manifest from "./limezu-manifest.json";

export interface AtlasSlice {
  /** Manifest key, e.g. "office_main" or "rb_walls". */
  atlas: string;
  /** Top-left tile column (0-indexed). */
  col: number;
  /** Top-left tile row (0-indexed). */
  row: number;
  /** Width in tiles. Defaults to 1. */
  spanCols?: number;
  /** Height in tiles. Defaults to 1. */
  spanRows?: number;
}

export const TILE_PX = manifest.tileSize;
export const ATLAS_PUBLIC_PREFIX = manifest.publicPathPrefix;

interface AtlasMeta {
  key: string;
  file: string;
  cols: number;
  rows: number;
}

const atlasIndex = new Map<string, AtlasMeta>();
for (const a of manifest.atlases) {
  atlasIndex.set(a.key, a);
}
for (const c of manifest.characters) {
  atlasIndex.set(c.key, c);
}

/** Returns the public URL for an atlas's PNG. */
export function atlasUrl(key: string): string {
  const meta = atlasIndex.get(key);
  if (!meta) throw new Error(`unknown atlas key: ${key}`);
  return `${ATLAS_PUBLIC_PREFIX}/${meta.file}`;
}

/** Frame index that Phaser uses when rendering this slice's top-left cell. */
export function sliceFrame(slice: AtlasSlice): number {
  const meta = atlasIndex.get(slice.atlas);
  if (!meta) throw new Error(`unknown atlas: ${slice.atlas}`);
  return slice.row * meta.cols + slice.col;
}

/** Calls scene.load.spritesheet(...) for every atlas in the manifest.
 *  Idempotent — Phaser silently skips reloads of an already-cached key. */
export function preloadAtlases(scene: Phaser.Scene): void {
  for (const meta of atlasIndex.values()) {
    scene.load.spritesheet(meta.key, `${ATLAS_PUBLIC_PREFIX}/${meta.file}`, {
      frameWidth: TILE_PX,
      frameHeight: TILE_PX,
    });
  }
}

/** Draw a slice at the given pixel coordinates. For multi-tile slices we
 *  draw spanCols × spanRows individual tiles — Phaser handles this faster
 *  than slicing into a sub-image. Returns the array of created images so
 *  callers can apply tints / depths uniformly. */
export function drawSlice(
  scene: Phaser.Scene,
  slice: AtlasSlice,
  x: number,
  y: number,
  depth: number,
): Phaser.GameObjects.Image[] {
  const meta = atlasIndex.get(slice.atlas);
  if (!meta) {
    throw new Error(`unknown atlas: ${slice.atlas}`);
  }
  const spanC = slice.spanCols ?? 1;
  const spanR = slice.spanRows ?? 1;
  const out: Phaser.GameObjects.Image[] = [];
  for (let dr = 0; dr < spanR; dr++) {
    for (let dc = 0; dc < spanC; dc++) {
      const frame = (slice.row + dr) * meta.cols + (slice.col + dc);
      const img = scene.add
        .image(x + dc * TILE_PX, y + dr * TILE_PX, meta.key, frame)
        .setOrigin(0, 0)
        .setDepth(depth);
      out.push(img);
    }
  }
  return out;
}

/** Bounds-check a slice against the atlas grid; throws if out of range.
 *  Useful at module load time to catch typos in the TILE catalog. */
export function validateSlice(slice: AtlasSlice): void {
  const meta = atlasIndex.get(slice.atlas);
  if (!meta) {
    throw new Error(`validateSlice: unknown atlas ${slice.atlas}`);
  }
  const spanC = slice.spanCols ?? 1;
  const spanR = slice.spanRows ?? 1;
  if (
    slice.col < 0 ||
    slice.row < 0 ||
    slice.col + spanC > meta.cols ||
    slice.row + spanR > meta.rows
  ) {
    throw new Error(
      `validateSlice: ${slice.atlas}(${slice.col},${slice.row} +${spanC}x${spanR}) out of range ${meta.cols}x${meta.rows}`,
    );
  }
}

export function listAtlases(): AtlasMeta[] {
  return manifest.atlases.map((a) => ({ ...a }));
}

export function listCharacterSheets(): AtlasMeta[] {
  return manifest.characters.map((c) => ({ ...c }));
}
