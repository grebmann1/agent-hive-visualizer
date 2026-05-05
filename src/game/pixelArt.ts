// ============================================================================
// Pixel art bindings for the Kenney "Tiny Dungeon" tileset (CC0, kenney.nl).
//
// The public API of this module must stay stable:
//   - TILE:   tile-index constants into the tilemap
//   - CHAR_FRAME: frame-index constants (0..7) for our 8-frame character sheet
//   - TILESET_URL — where Phaser loads the tilemap PNG
//   - buildCharacterSheetFromTile(tilemapImage, baseTile, overrides) — produces
//     a per-NPC 128×16 spritesheet synthesized from a single character tile in
//     the tilemap. Replaces the old buildCharacterCanvasTinted() which worked
//     from a separate pre-baked character sheet.
//
// The Tiny Dungeon tilesheet is packed 12 cols × 11 rows of 16×16 tiles
// (192×176 px, no spacing). Character tiles live on rows 7–10.
// ============================================================================

export const TILESET_URL = "/assets/tilesets/tiny-dungeon.png";

// Fallback character tile (the original "farmer" Kenney sprite used before this
// change). Used when a caller does not supply a baseTile.
export const DEFAULT_CHARACTER_TILE = 85;

// Frame indices into tiny-dungeon.png (row * 12 + col).
// The names on the RHS describe what each Kenney tile actually depicts.
export const TILE = {
  FLOOR: 48, // plain tan/sand floor (flat, no pattern)
  FLOOR_PLAIN: 48, // same plain sand floor
  WALL_TOP: 40, // stone brick wall — used as wall everywhere
  WALL_LOW: 40, // stone brick wall (Kenney has no distinct low-wall variant)
  WALL_SOLID: 40, // stone brick wall
  DESK_TOP: 65, // helm on a stand — closest "workstation" substitute
  DESK_BOTTOM: 73, // small wooden stool — reads as a chair under the desk
  BOOKSHELF_TOP: 75, // tall wooden bookshelf — great library match
  BOOKSHELF_BOTTOM: 66, // round wooden shield — stands in for lower shelf
  LAB_TOP: 64, // metal helmet/altar piece — substitute for a "lab machine"
  LAB_BOTTOM: 73, // small wooden stool
  GEAR_TOP: 74, // ANVIL — perfect for the tool workshop
  GEAR_BOTTOM: 73, // small wooden stool (apprentice spot!)
  DOOR_OPEN: 48, // same as floor — door is just a walkable gap in the wall
  RUG: 49, // sand floor with small pebbles — subtle color variation
  CHAIR: 72, // brown armchair
  PLANT: 113, // green potion bottle — no real plant in Tiny Dungeon,
  //            a round bottle is the closest small decoration.
  WALL_TL: 40, // stone wall (Kenney has no distinct corners at this res)
  WALL_TR: 40, // stone wall
  // CP5 — exterior tiles. Both use the tan FLOOR base sprite; drawMap tints
  // them by the logical kind (grass = green, path = brown). Keeping them as
  // separate TILE entries lets layout arrays mark intent and lets drawMap
  // distinguish interior floors from exterior ones.
  GRASS: 48,
  PATH: 49,
  TREE: 75, // the bookshelf-as-tree-trunk — stumpy but reads as vertical mass
};

// Marker ranges so drawMap can classify exterior tiles without needing a
// separate layer. Exterior tiles use logical ids 400+ that map to real
// sprite indices via EXTERIOR_TILE_SPRITE. We keep them >= 200 so they
// never collide with the tiny-dungeon atlas's 0..131.
export const EXT_GRASS = 400;
export const EXT_PATH = 401;
export const EXT_TREE = 402;

export const EXTERIOR_TILE_SPRITE: Record<number, number> = {
  [EXT_GRASS]: 48,
  [EXT_PATH]: 49,
  [EXT_TREE]: 75,
};

// 8-frame character sheet layout (128×16):
//   0 down0 | 1 down1 | 2 up0 | 3 up1 | 4 left0 | 5 left1 | 6 right0 | 7 right1
export const CHAR_FRAME = {
  DOWN_0: 0,
  DOWN_1: 1,
  UP_0: 2,
  UP_1: 3,
  LEFT_0: 4,
  LEFT_1: 5,
  RIGHT_0: 6,
  RIGHT_1: 7,
};

// ============================================================================
// "Face palette" of Kenney Tiny Dungeon character tiles. Used to detect which
// pixels belong to the face/eyes when synthesizing the "back of head" (up)
// frames. Tolerance is applied per-channel to absorb minor variations.
// ============================================================================

const SKIN_RGB: [number, number, number] = [247, 194, 130];
const SKIN_SHADOW_RGB: [number, number, number] = [225, 154, 101];
const EYE_RGB: [number, number, number] = [38, 43, 68];
const DARK_OUTLINE_RGB: [number, number, number] = [63, 38, 49];
const HAIR_RGB: [number, number, number] = [118, 59, 54];

const COLOR_TOL = 6;

function isClose(
  r: number,
  g: number,
  b: number,
  target: [number, number, number],
  tol = COLOR_TOL,
) {
  return (
    Math.abs(r - target[0]) <= tol &&
    Math.abs(g - target[1]) <= tol &&
    Math.abs(b - target[2]) <= tol
  );
}

function isSkin(r: number, g: number, b: number) {
  return isClose(r, g, b, SKIN_RGB) || isClose(r, g, b, SKIN_SHADOW_RGB);
}

function isEye(r: number, g: number, b: number) {
  return isClose(r, g, b, EYE_RGB);
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([a-f\d]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// ---- Helpers to work with 16×16 RGBA tile buffers ----
type Tile = Uint8ClampedArray; // length 16*16*4

const TILE_SIZE = 16;
const TILE_BYTES = TILE_SIZE * TILE_SIZE * 4;

function extractTile(
  source: CanvasRenderingContext2D,
  baseTile: number,
): Tile {
  const col = baseTile % 12;
  const row = Math.floor(baseTile / 12);
  const img = source.getImageData(col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
  return img.data;
}

function cloneTile(t: Tile): Tile {
  const out = new Uint8ClampedArray(TILE_BYTES);
  out.set(t);
  return out;
}

function pixelAt(t: Tile, x: number, y: number): [number, number, number, number] {
  const off = (y * TILE_SIZE + x) * 4;
  return [t[off], t[off + 1], t[off + 2], t[off + 3]];
}

function setPixel(
  t: Tile,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
) {
  const off = (y * TILE_SIZE + x) * 4;
  t[off] = r;
  t[off + 1] = g;
  t[off + 2] = b;
  t[off + 3] = a;
}

// Shift all non-transparent pixels up by 1 row. The top row becomes whatever
// was originally on row 1; the bottom row becomes transparent. Gives a gentle
// "bob" for the walk cycle.
function bobUp(t: Tile): Tile {
  const out = new Uint8ClampedArray(TILE_BYTES);
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const dstOff = (y * TILE_SIZE + x) * 4;
      const srcY = y + 1;
      if (srcY >= TILE_SIZE) continue; // leave transparent
      const srcOff = (srcY * TILE_SIZE + x) * 4;
      out[dstOff] = t[srcOff];
      out[dstOff + 1] = t[srcOff + 1];
      out[dstOff + 2] = t[srcOff + 2];
      out[dstOff + 3] = t[srcOff + 3];
    }
  }
  return out;
}

function flipH(t: Tile): Tile {
  const out = new Uint8ClampedArray(TILE_BYTES);
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const srcOff = (y * TILE_SIZE + (TILE_SIZE - 1 - x)) * 4;
      const dstOff = (y * TILE_SIZE + x) * 4;
      out[dstOff] = t[srcOff];
      out[dstOff + 1] = t[srcOff + 1];
      out[dstOff + 2] = t[srcOff + 2];
      out[dstOff + 3] = t[srcOff + 3];
    }
  }
  return out;
}

/**
 * Build an "up" variant by masking out the face. We replace skin and eye
 * pixels with the tile's dominant hair color (if any) or dark outline so the
 * character looks like it's facing away. Pixels below the face band are
 * unchanged.
 *
 * Face band is empirically rows 3–9 of a 16×16 Kenney character.
 */
function buildUpFrame(src: Tile): Tile {
  const out = cloneTile(src);
  // Determine a fallback "back of head" color: prefer hair color if present
  // in the source, else dark outline.
  let replacement: [number, number, number] = HAIR_RGB;
  let hairFound = false;
  for (let i = 0; i < src.length; i += 4) {
    if (src[i + 3] === 0) continue;
    if (isClose(src[i], src[i + 1], src[i + 2], HAIR_RGB)) {
      hairFound = true;
      break;
    }
  }
  if (!hairFound) replacement = DARK_OUTLINE_RGB;

  for (let y = 2; y <= 9; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const [r, g, b, a] = pixelAt(out, x, y);
      if (a === 0) continue;
      if (isSkin(r, g, b) || isEye(r, g, b)) {
        setPixel(out, x, y, replacement[0], replacement[1], replacement[2], 255);
      }
    }
  }
  return out;
}

/**
 * Detect the two most-common non-outline, non-transparent colors in the lower
 * half (rows 9–15) of a tile. Treats those as the "shirt" slots that get
 * recolored by the per-NPC tint. Works for any character tile without needing
 * a hard-coded palette.
 *
 * Returns [lightKey, shadowKey] where "light" is whichever of the two top
 * colors has the higher luminance. Either may be null if the tile has very
 * little lower-body color.
 */
function detectShirtSlots(
  src: Tile,
): { light: [number, number, number] | null; shadow: [number, number, number] | null } {
  const counts = new Map<string, number>();
  for (let y = 9; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const [r, g, b, a] = pixelAt(src, x, y);
      if (a === 0) continue;
      // Skip the common "outline/shadow" colors that are not shirts.
      if (isClose(r, g, b, DARK_OUTLINE_RGB)) continue;
      if (isSkin(r, g, b)) continue;
      if (isEye(r, g, b)) continue;
      if (isClose(r, g, b, HAIR_RGB)) continue;
      const key = `${r},${g},${b}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 2).map(([k]) => k.split(",").map(Number) as [number, number, number]);
  if (top.length === 0) return { light: null, shadow: null };
  if (top.length === 1) return { light: top[0], shadow: null };
  // Order by luminance: lighter one is "L", darker is "l".
  const lum = (c: [number, number, number]) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  if (lum(top[0]) >= lum(top[1])) return { light: top[0], shadow: top[1] };
  return { light: top[1], shadow: top[0] };
}

/**
 * Apply the per-NPC tint to a tile in-place. Every pixel matching the detected
 * "shirt light" slot is swapped with overrides.L (if supplied); every pixel
 * matching the "shirt shadow" slot is swapped with overrides.l (if supplied).
 */
function applyTint(
  t: Tile,
  slots: { light: [number, number, number] | null; shadow: [number, number, number] | null },
  overrides: { l?: string; L?: string; d?: string },
) {
  const newL = overrides.L ? hexToRgb(overrides.L) : null;
  const newl = overrides.l ? hexToRgb(overrides.l) : null;
  if (!newL && !newl) return;
  for (let i = 0; i < t.length; i += 4) {
    if (t[i + 3] === 0) continue;
    const r = t[i], g = t[i + 1], b = t[i + 2];
    if (newL && slots.light && isClose(r, g, b, slots.light, 0)) {
      t[i] = newL[0]; t[i + 1] = newL[1]; t[i + 2] = newL[2];
    } else if (newl && slots.shadow && isClose(r, g, b, slots.shadow, 0)) {
      t[i] = newl[0]; t[i + 1] = newl[1]; t[i + 2] = newl[2];
    }
  }
}

function blitTile(
  outCtx: CanvasRenderingContext2D,
  t: Tile,
  dstX: number,
) {
  // Create a fresh ImageData at the canvas's native size and copy bytes into
  // it. Avoids TS strictness issues with ImageData(Uint8ClampedArray, ...) on
  // certain TS lib configurations.
  const img = outCtx.createImageData(TILE_SIZE, TILE_SIZE);
  img.data.set(t);
  outCtx.putImageData(img, dstX, 0);
}

/**
 * Build a 128×16 8-frame character spritesheet from a single character tile
 * in the Kenney Tiny Dungeon tilemap.
 *
 * Frames (left → right): down0, down1, up0, up1, left0, left1, right0, right1
 *
 * Kenney Tiny Dungeon does not ship back/side views, so we synthesize them:
 *   - down0 = source tile as-is
 *   - down1 = source tile bobbed up 1px (subtle "step")
 *   - up0   = source with face (skin + eyes) masked by hair/outline color
 *   - up1   = up0 bobbed
 *   - left0 = source mirrored horizontally
 *   - left1 = left0 bobbed
 *   - right0 = source as-is (slightly different from down0 via no bob)
 *   - right1 = right0 bobbed
 *
 * Per-NPC tint: overrides.L swaps the tile's "light shirt" slot; overrides.l
 * swaps the "shadow shirt" slot. The slots are auto-detected per-tile by
 * finding the two most-common non-outline/non-skin/non-hair colors in the
 * lower half of the tile.
 */
export function buildCharacterSheetFromTile(
  tilemapImage: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  baseTile: number,
  overrides: { l?: string; L?: string; d?: string } = {},
): HTMLCanvasElement {
  // Draw the full tilemap onto a scratch canvas so we can read pixel data.
  const w =
    (tilemapImage as HTMLImageElement).naturalWidth ||
    (tilemapImage as HTMLCanvasElement).width ||
    (tilemapImage as ImageBitmap).width;
  const h =
    (tilemapImage as HTMLImageElement).naturalHeight ||
    (tilemapImage as HTMLCanvasElement).height ||
    (tilemapImage as ImageBitmap).height;
  const scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  const scratchCtx = scratch.getContext("2d", { willReadFrequently: true })!;
  scratchCtx.imageSmoothingEnabled = false;
  scratchCtx.drawImage(tilemapImage as CanvasImageSource, 0, 0);

  // Extract the source tile and pre-compute tinted variants.
  const rawSource = extractTile(scratchCtx, baseTile);
  const slots = detectShirtSlots(rawSource);
  const tintedSource = cloneTile(rawSource);
  applyTint(tintedSource, slots, overrides);

  // Build the 8 frames from the *tinted* source so colors stay consistent.
  const down0 = cloneTile(tintedSource);
  const down1 = bobUp(down0);
  const up0 = buildUpFrame(tintedSource);
  const up1 = bobUp(up0);
  const right0 = cloneTile(tintedSource);
  const right1 = bobUp(right0);
  const left0 = flipH(tintedSource);
  const left1 = bobUp(left0);

  // Compose the final 128×16 sheet.
  const sheet = document.createElement("canvas");
  sheet.width = TILE_SIZE * 8;
  sheet.height = TILE_SIZE;
  const ctx = sheet.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  const frames = [down0, down1, up0, up1, left0, left1, right0, right1];
  for (let i = 0; i < frames.length; i++) {
    blitTile(ctx, frames[i], i * TILE_SIZE);
  }
  return sheet;
}
