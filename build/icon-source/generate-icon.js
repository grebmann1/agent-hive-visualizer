/**
 * Generates the Agent Force HQ app icon at 1024×1024.
 *
 * Top-down floor plan of HQ: colored specialty rooms ring a central
 * desk bullpen, with a welcome plaza at the entrance. Small dots are
 * agents at work. Mint-cyan glow border matches the in-app palette.
 *
 * Output: build/icon-source/icon-1024.png
 */
const path = require('path');
const sharp = require('sharp');

// Background card
const BG = '#0e1018';
const BG_INNER = '#171b2c';
const BORDER = '#2a3150';
const GLOW = '#6ee7b7';

// Floor / corridor
const FLOOR = '#2a2a36';
const FLOOR_LIGHT = '#34344a';
const CORRIDOR = '#3d3d52';

// Specialty room tints (top row + side rooms)
const ROOM_PURPLE = '#5b3a7c';
const ROOM_BLUE = '#2f6fa8';
const ROOM_AMBER = '#a87a3a';
const ROOM_TEAL = '#2f8a8a';
const ROOM_GREEN = '#3a7a4a';
const ROOM_RED = '#9a3a3a';
const ROOM_BROWN = '#6b4a32';

// Furniture
const DESK = '#7a5a32';
const DESK_DARK = '#4a3220';
const CHAIR = '#2c2c40';

// Accents
const SIGN_BG = '#1f2a44';
const SIGN_TEXT = '#6ee7b7';
const MAT = '#6ee7b7';
const PLANT = '#3a7a4a';

// Agent dot colors
const AGENT_A = '#fbbf24';
const AGENT_B = '#5aa3ea';
const AGENT_C = '#e5a8d4';

// === Layout constants ===
// Card sits at (40,40)-(984,984) inside the 1024 canvas (rounded card).
// Plan area: (80,80)-(944,944) — 864×864.

// Helper: a tinted room rect with a darker outline + a tiny "label bar"
function room(x, y, w, h, tint, opts = {}) {
  const { label = true, items = '' } = opts;
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${tint}"/>`;
  // Inner darker top-stripe (room "name plate")
  if (label) {
    s += `<rect x="${x + 6}" y="${y + 6}" width="${w - 12}" height="14" fill="${BG_INNER}" opacity="0.7"/>`;
    s += `<rect x="${x + 10}" y="${y + 10}" width="${w - 20}" height="4" fill="${SIGN_TEXT}" opacity="0.55"/>`;
  }
  // Outline
  s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${BG}" stroke-width="3"/>`;
  s += items;
  return s;
}

// Helper: a desk + chair pair (top-down)
function desk(x, y) {
  return `
    <rect x="${x}" y="${y}" width="44" height="28" fill="${DESK}"/>
    <rect x="${x}" y="${y}" width="44" height="6" fill="${DESK_DARK}"/>
    <rect x="${x + 12}" y="${y + 30}" width="20" height="14" fill="${CHAIR}"/>
  `;
}

// Helper: an agent dot (shoulders + head)
function agent(x, y, color) {
  return `
    <rect x="${x - 6}" y="${y - 4}" width="12" height="10" fill="${color}"/>
    <rect x="${x - 4}" y="${y - 12}" width="8" height="8" fill="#f6c89a"/>
  `;
}

// Helper: a small plant
function plant(x, y) {
  return `
    <rect x="${x}" y="${y}" width="14" height="14" fill="${BG}" opacity="0.4"/>
    <circle cx="${x + 7}" cy="${y + 7}" r="6" fill="${PLANT}"/>
  `;
}

// === Top row: 6 specialty rooms ===
function topRow() {
  const y = 100;
  const h = 110;
  const tints = [ROOM_PURPLE, ROOM_BLUE, ROOM_AMBER, ROOM_TEAL, ROOM_GREEN, ROOM_RED];
  const w = 130;
  const startX = 110;
  const gap = 8;
  let s = '';
  for (let i = 0; i < 6; i++) {
    const x = startX + i * (w + gap);
    s += room(x, y, w, h, tints[i]);
    // a little furniture inside
    s += `<rect x="${x + 14}" y="${y + 36}" width="${w - 28}" height="14" fill="${BG}" opacity="0.35"/>`;
    s += `<rect x="${x + 14}" y="${y + 60}" width="${w - 60}" height="10" fill="${BG}" opacity="0.45"/>`;
  }
  return s;
}

// === Left column: 3 stacked rooms ===
function leftColumn() {
  const x = 110;
  const w = 150;
  const ys = [240, 360, 480];
  const tints = [ROOM_TEAL, ROOM_AMBER, ROOM_RED];
  let s = '';
  for (let i = 0; i < 3; i++) {
    s += room(x, ys[i], w, 110, tints[i], {
      items: `
        <rect x="${x + 14}" y="${ys[i] + 38}" width="${w - 28}" height="14" fill="${BG}" opacity="0.35"/>
        <rect x="${x + 14}" y="${ys[i] + 62}" width="${w - 50}" height="10" fill="${BG}" opacity="0.45"/>
      `
    });
  }
  return s;
}

// === Right column: 3 stacked rooms ===
function rightColumn() {
  const x = 764;
  const w = 150;
  const ys = [240, 360, 480];
  const tints = [ROOM_BROWN, ROOM_BLUE, ROOM_GREEN];
  let s = '';
  for (let i = 0; i < 3; i++) {
    s += room(x, ys[i], w, 110, tints[i], {
      items: `
        <rect x="${x + 14}" y="${ys[i] + 38}" width="${w - 28}" height="14" fill="${BG}" opacity="0.35"/>
        <rect x="${x + 14}" y="${ys[i] + 62}" width="${w - 50}" height="10" fill="${BG}" opacity="0.45"/>
      `
    });
  }
  return s;
}

// === Bottom row: 4 small rooms framing the entrance ===
function bottomRow() {
  const y = 700;
  const h = 80;
  let s = '';
  // Two left rooms
  s += room(110, y, 130, h, ROOM_PURPLE);
  s += room(248, y, 170, h, ROOM_TEAL);
  // Center entrance lobby (overlapping band)
  s += `<rect x="426" y="${y - 4}" width="172" height="${h + 8}" fill="${SIGN_BG}"/>`;
  s += `<rect x="426" y="${y - 4}" width="172" height="3" fill="${SIGN_TEXT}" opacity="0.8"/>`;
  s += `<rect x="426" y="${y + h + 1}" width="172" height="3" fill="${SIGN_TEXT}" opacity="0.8"/>`;
  // tiny "WELCOME" sign — abstract bar
  s += `<rect x="442" y="${y + 16}" width="140" height="20" fill="${BG}" opacity="0.7"/>`;
  s += `<rect x="450" y="${y + 22}" width="124" height="8" fill="${SIGN_TEXT}"/>`;
  // Two right rooms
  s += room(606, y, 170, h, ROOM_BLUE);
  s += room(784, y, 130, h, ROOM_BROWN);
  return s;
}

// === Center bullpen: grid of desks ===
function bullpen() {
  // Floor area
  let s = `<rect x="278" y="240" width="468" height="450" fill="${FLOOR}"/>`;
  s += `<rect x="278" y="240" width="468" height="6" fill="${FLOOR_LIGHT}"/>`;

  // Mission Control sign at top
  s += `<rect x="320" y="252" width="384" height="36" fill="${SIGN_BG}"/>`;
  s += `<rect x="320" y="252" width="384" height="3" fill="${SIGN_TEXT}"/>`;
  s += `<rect x="320" y="285" width="384" height="3" fill="${SIGN_TEXT}"/>`;
  s += `<rect x="346" y="262" width="332" height="14" fill="${SIGN_TEXT}" opacity="0.85"/>`;

  // 4 rows × 4 desks
  const rowYs = [310, 400, 490, 580];
  const colXs = [300, 380, 540, 620];
  for (let r = 0; r < rowYs.length; r++) {
    for (let c = 0; c < colXs.length; c++) {
      s += desk(colXs[c], rowYs[r]);
    }
  }

  // Central conference table
  s += `<rect x="464" y="430" width="96" height="120" fill="${DESK_DARK}"/>`;
  s += `<rect x="464" y="430" width="96" height="6" fill="${ROOM_AMBER}"/>`;
  s += `<rect x="476" y="468" width="72" height="44" fill="${DESK}"/>`;

  // Plants between desk clusters
  s += plant(488, 330);
  s += plant(488, 580);
  s += plant(312, 690);
  s += plant(700, 690);

  // Agent dots scattered at desks
  s += agent(322, 410, AGENT_A);
  s += agent(402, 320, AGENT_B);
  s += agent(642, 500, AGENT_C);
  s += agent(562, 410, AGENT_A);
  s += agent(322, 590, AGENT_B);
  s += agent(642, 590, AGENT_C);
  s += agent(402, 500, AGENT_A);

  return s;
}

// === Plaza at the very bottom: walkway, fountain, lamps ===
function plaza() {
  const y = 798;
  // Plaza ground
  let s = `<rect x="80" y="${y}" width="864" height="146" fill="${FLOOR_LIGHT}"/>`;
  s += `<rect x="80" y="${y}" width="864" height="6" fill="${BORDER}"/>`;
  // Hedges
  s += `<rect x="100" y="${y + 30}" width="190" height="20" fill="${PLANT}"/>`;
  s += `<rect x="734" y="${y + 30}" width="190" height="20" fill="${PLANT}"/>`;
  // Path leading to entrance
  s += `<rect x="476" y="${y}" width="72" height="146" fill="${CORRIDOR}"/>`;
  // Fountain
  s += `<rect x="476" y="${y + 60}" width="72" height="60" fill="${BG_INNER}"/>`;
  s += `<circle cx="512" cy="${y + 90}" r="22" fill="${ROOM_BLUE}"/>`;
  s += `<circle cx="512" cy="${y + 90}" r="10" fill="${SIGN_TEXT}" opacity="0.85"/>`;
  // Lamps
  s += `<circle cx="380" cy="${y + 70}" r="6" fill="${AGENT_A}"/>`;
  s += `<circle cx="644" cy="${y + 70}" r="6" fill="${AGENT_A}"/>`;
  // Benches
  s += `<rect x="170" y="${y + 90}" width="60" height="14" fill="${DESK}"/>`;
  s += `<rect x="794" y="${y + 90}" width="60" height="14" fill="${DESK}"/>`;
  return s;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" shape-rendering="crispEdges">
  <defs>
    <linearGradient id="card" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#1c2032"/>
      <stop offset="100%" stop-color="#0e1018"/>
    </linearGradient>
  </defs>

  <!-- Outer dark backdrop -->
  <rect width="1024" height="1024" rx="180" ry="180" fill="${BG}"/>

  <!-- Inner card (the "tray") with mint glow border -->
  <rect x="40" y="40" width="944" height="944" rx="150" ry="150" fill="url(#card)"/>
  <rect x="40" y="40" width="944" height="944" rx="150" ry="150"
        fill="none" stroke="${GLOW}" stroke-width="4" opacity="0.95"/>
  <rect x="56" y="56" width="912" height="912" rx="138" ry="138"
        fill="none" stroke="${GLOW}" stroke-width="2" opacity="0.35"/>

  <!-- Floor base inside the tray -->
  <rect x="80" y="80" width="864" height="864" fill="${BG_INNER}"/>

  <!-- Top row of rooms -->
  ${topRow()}

  <!-- Side rooms -->
  ${leftColumn()}
  ${rightColumn()}

  <!-- Central bullpen with desks + agents -->
  ${bullpen()}

  <!-- Bottom row + entrance lobby -->
  ${bottomRow()}

  <!-- Plaza out front -->
  ${plaza()}
</svg>`;

const outPath = path.join(__dirname, 'icon-1024.png');

sharp(Buffer.from(svg))
  .png()
  .toFile(outPath)
  .then((info) => {
    console.log(`Icon generated: ${outPath} (${info.width}x${info.height}, ${info.size} bytes)`);
  })
  .catch((err) => {
    console.error('Failed to generate icon:', err);
    process.exit(1);
  });
