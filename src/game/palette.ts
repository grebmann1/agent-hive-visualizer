// Retro Game Boy 4-color green palette — kept around as a neutral app-chrome
// color (camera background, scene fill) even though the tile/character art
// itself is now Kenney's full-color "Tiny Dungeon" pack.
export const GB = {
  darkest: "#0f380f",
  dark: "#306230",
  light: "#8bac0f",
  lightest: "#9bbc0f",
} as const;

export const TILE_SIZE = 16;

// Per-room color theme. Applied to floor tiles in WorldScene.drawMap via
// Phaser's image.setTint() — we don't swap the sprite source, just multiply
// it by these hues to make rooms visually distinct at a glance. `accent`
// is reserved for the eventual per-room furniture pass; not used yet.
import type { RoomId } from "../events/types";
export const ROOM_PALETTE: Record<RoomId, { floor: number; accent: number }> = {
  library:       { floor: 0xf0e4c0, accent: 0xc59b6d }, // warm cream
  coding_room:   { floor: 0xd9b685, accent: 0x8b5a3c }, // warm wood
  desk:          { floor: 0xcfd8e0, accent: 0x6b7a8a }, // cool blue-grey (Control Room)
  tool_workshop: { floor: 0xe8b89a, accent: 0xb86a52 }, // warm tile red (Kitchen)
  testing_lab:   { floor: 0xcfe8d8, accent: 0x6ab08c }, // cool mint
  cinema:        { floor: 0xefc4cb, accent: 0xb37079 }, // pink carpet (Lounge)
  meeting_room:  { floor: 0xe8d49c, accent: 0xa8803c }, // warm gold
};

// Neutral floor tint used for aisles and unclaimed cells — slight warm off-
// white so the tinted rooms read as warmer/cooler contrasts rather than
// tinted-vs-raw. Keep this close to the Kenney tile's actual tone.
export const NEUTRAL_FLOOR_TINT = 0xf4ecd8;
