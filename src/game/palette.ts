// Retro Game Boy 4-color green palette — kept around as a neutral
// app-chrome color (camera background, scene fill).
export const GB = {
  darkest: "#0f380f",
  dark: "#306230",
  light: "#8bac0f",
  lightest: "#9bbc0f",
} as const;

// World tile size in pixels. Tied to the source map's tilewidth/tileheight
// (the Tiled `.tmj` we ship is 32×32). Bump in lockstep with that.
export const TILE_SIZE = 32;
