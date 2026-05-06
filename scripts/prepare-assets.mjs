#!/usr/bin/env node
// prepare-assets — copies the LimeZu Modern Interiors / Modern Office /
// Premade-Character PNGs from the user-supplied download dirs into
// public/assets/limezu/ and writes src/game/limezu-manifest.json so the
// renderer can load each atlas with the right grid dimensions.
//
// Run after downloading the LimeZu zips:
//
//   node scripts/prepare-assets.mjs \
//     --interiors "/Users/you/Downloads/moderninteriors-win" \
//     --office    "/Users/you/Downloads/Modern_Office_Revamped_v1.2"
//
// Defaults match the paths the user gave us during planning. Re-running
// is safe — it overwrites the destination files.
//
// Why not commit the PNGs? LimeZu's commercial license allows shipping
// extracted PNGs inside a compiled app, but explicitly forbids
// redistributing the raw asset zip / files. The script lives in-repo so
// any contributor with their own LimeZu purchase can rehydrate the
// gitignored `public/assets/limezu/` directory.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..");
const DEST_DIR = join(REPO_ROOT, "public", "assets", "limezu");
const MANIFEST_PATH = join(REPO_ROOT, "src", "game", "limezu-manifest.json");

const TILE_SIZE = 16;

// Read PNG width/height from the first 24 bytes of the file (IHDR chunk
// follows the 8-byte signature). Avoids pulling a third-party dep.
function pngDimensions(path) {
  const buf = readFileSync(path);
  if (buf.length < 24) throw new Error(`not a PNG: ${path}`);
  // Big-endian u32 at offset 16 = width, offset 20 = height.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

// Source -> destination spec. `source` is relative to the relevant root.
// `purpose` is documentation-only. Atlases that drive in-game rendering
// land in the manifest with grid dimensions derived from PNG size.
//
// NOTE: The top-level `Room_Builder_16x16.png` and
// `Room_Builder_Office_16x16.png` are LimeZu *guide images* — promo art,
// not tile atlases. We deliberately skip them and pull from the
// `Room_Builder_subfiles/` folder where the real walls/floors/doors live.
const PLAN = {
  // ROOT: moderninteriors-win
  interiors: [
    // --- Room-builder subfiles (the actual walls/floors/doors)
    {
      source: "1_Interiors/16x16/Room_Builder_subfiles/Room_Builder_Walls_16x16.png",
      key: "rb_walls",
      purpose: "walls (32x40) — color variants for vertical/horizontal",
    },
    {
      source: "1_Interiors/16x16/Room_Builder_subfiles/Room_Builder_Floors_16x16.png",
      key: "rb_floors",
      purpose: "floor patterns (15x40) — wood, tile, carpet, concrete",
    },
    {
      source: "1_Interiors/16x16/Room_Builder_subfiles/Room_Builder_Arched_Entryways_16x16.png",
      key: "rb_arches",
      purpose: "arched doorways — color variants",
    },
    {
      source: "1_Interiors/16x16/Room_Builder_subfiles/Room_Builder_Floor_Paths_16x16.png",
      key: "rb_paths",
      purpose: "exterior dirt/stone path tiles",
    },
    {
      source: "1_Interiors/16x16/Room_Builder_subfiles/Room_Builder_Floor_Connectors_16x16.png",
      key: "rb_connectors",
      purpose: "floor edge transitions between rooms",
    },
    // --- Theme sorter (specialty furniture per room)
    {
      source: "1_Interiors/16x16/Theme_Sorter/1_Generic_16x16.png",
      key: "theme_generic",
      purpose: "generic furniture (desks, shelves, plants)",
    },
    {
      source: "1_Interiors/16x16/Theme_Sorter/2_LivingRoom_16x16.png",
      key: "theme_livingroom",
      purpose: "couches, TVs, rugs — used for Lounge",
    },
    {
      source: "1_Interiors/16x16/Theme_Sorter/5_Classroom_and_library_16x16.png",
      key: "theme_library",
      purpose: "bookshelves, blackboards — Library room",
    },
    {
      source: "1_Interiors/16x16/Theme_Sorter/12_Kitchen_16x16.png",
      key: "theme_kitchen",
      purpose: "fridges, stoves, counters — Kitchen room",
    },
    {
      source: "1_Interiors/16x16/Theme_Sorter/13_Conference_Hall_16x16.png",
      key: "theme_conference",
      purpose: "round tables, conference chairs — Meeting Room",
    },
    {
      source: "1_Interiors/16x16/Theme_Sorter/19_Hospital_16x16.png",
      key: "theme_hospital",
      purpose: "lab/medical machines — Test Rig stand-in",
    },
  ],
  // ROOT: Modern_Office_Revamped_v1.2
  office: [
    {
      source: "Modern_Office_16x16.png",
      key: "office_main",
      purpose: "office desks, monitors, chairs — Workshop + Control Room",
    },
  ],
};

// Premade characters — copy first N character sheets so we have visual
// variety for the dynamic NPC roster. Each PNG is one character with all
// animations stacked.
const PREMADE_CHAR_COUNT = 20;

function parseArgs(argv) {
  const out = { interiors: null, office: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--interiors") out.interiors = argv[++i];
    else if (arg === "--office") out.office = argv[++i];
    else throw new Error(`unknown arg: ${arg}`);
  }
  if (!out.interiors) {
    out.interiors = "/Users/grebmann/Downloads/moderninteriors-win";
  }
  if (!out.office) {
    out.office = "/Users/grebmann/Downloads/Modern_Office_Revamped_v1.2";
  }
  return out;
}

function copyAtlas({ srcRoot, source, key, purpose }) {
  const src = join(srcRoot, source);
  if (!existsSync(src)) {
    throw new Error(`missing source PNG: ${src}\n(check your --interiors / --office paths)`);
  }
  const dst = join(DEST_DIR, `${key}.png`);
  copyFileSync(src, dst);
  const { width, height } = pngDimensions(dst);
  // LimeZu's auxiliary atlases (e.g. Arched_Entryways at 160×520) aren't
  // perfectly tile-aligned — they include a few pixels of trailing accent
  // art. Don't reject these; floor-divide and let the consumer index only
  // the valid tile range.
  if (width % TILE_SIZE !== 0 || height % TILE_SIZE !== 0) {
    console.warn(
      `[prepare-assets] ${source}: ${width}x${height} px isn't a clean ` +
      `multiple of ${TILE_SIZE} — using floor cols=${Math.floor(width / TILE_SIZE)} rows=${Math.floor(height / TILE_SIZE)}`,
    );
  }
  return {
    key,
    file: `${key}.png`,
    cols: Math.floor(width / TILE_SIZE),
    rows: Math.floor(height / TILE_SIZE),
    tileSize: TILE_SIZE,
    pixelWidth: width,
    pixelHeight: height,
    sourcePath: source,
    purpose,
  };
}

function copyCharacters(interiorsRoot) {
  const charRoot = join(
    interiorsRoot,
    "2_Characters",
    "Character_Generator",
    "0_Premade_Characters",
    "16x16",
  );
  if (!existsSync(charRoot)) {
    throw new Error(`missing premade-characters dir: ${charRoot}`);
  }
  const out = [];
  for (let i = 1; i <= PREMADE_CHAR_COUNT; i++) {
    const fname = `Premade_Character_${String(i).padStart(2, "0")}.png`;
    const src = join(charRoot, fname);
    if (!existsSync(src)) {
      console.warn(`[prepare-assets] character ${i} not found; skipping`);
      continue;
    }
    const key = `char_${String(i).padStart(2, "0")}`;
    const dst = join(DEST_DIR, `${key}.png`);
    copyFileSync(src, dst);
    const { width, height } = pngDimensions(dst);
    out.push({
      key,
      file: `${key}.png`,
      cols: width / TILE_SIZE,
      rows: height / TILE_SIZE,
      tileSize: TILE_SIZE,
      pixelWidth: width,
      pixelHeight: height,
      sourcePath: `2_Characters/Character_Generator/0_Premade_Characters/16x16/${fname}`,
      purpose: `premade character ${i} (walk + idle + sit + phone animations stacked)`,
    });
  }
  return out;
}

function writeLicenseNotice() {
  const path = join(DEST_DIR, "LICENSE_NOTICE.md");
  const content = `# LimeZu pixel-art assets

The PNGs in this folder are extracted from licensed LimeZu products
(Modern Interiors full pack, Modern Office Revamped). They are
**gitignored** — see \`.gitignore\` — because LimeZu's license forbids
redistribution of the raw asset files outside a compiled application.

Run \`npm run prepare-assets\` after a fresh checkout to rehydrate this
folder from your local copy of the LimeZu downloads.

LimeZu credits required: https://limezu.itch.io
`;
  writeFileSync(path, content);
}

function main() {
  const args = parseArgs(process.argv);
  console.log(`[prepare-assets] interiors root: ${args.interiors}`);
  console.log(`[prepare-assets] office root:    ${args.office}`);

  mkdirSync(DEST_DIR, { recursive: true });

  const atlases = [];
  for (const spec of PLAN.interiors) {
    atlases.push(copyAtlas({ srcRoot: args.interiors, ...spec }));
  }
  for (const spec of PLAN.office) {
    atlases.push(copyAtlas({ srcRoot: args.office, ...spec }));
  }
  const characters = copyCharacters(args.interiors);

  const manifest = {
    generatedAt: new Date().toISOString(),
    tileSize: TILE_SIZE,
    publicPathPrefix: "/assets/limezu",
    atlases,
    characters,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  writeLicenseNotice();

  console.log(`[prepare-assets] wrote ${atlases.length} atlases + ${characters.length} characters`);
  console.log(`[prepare-assets] manifest: ${MANIFEST_PATH}`);
  console.log(`[prepare-assets] dest:     ${DEST_DIR}`);
}

main();
