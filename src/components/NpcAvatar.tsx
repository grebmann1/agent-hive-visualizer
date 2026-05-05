"use client";

// NpcAvatar — renders a 16×16 pixel-art preview of an NPC using the same
// Kenney tile + per-NPC palette swap that the Phaser scene uses. The avatar
// shares its underlying tilemap image with the whole app via a tiny in-module
// cache so we don't fetch `/assets/tilesets/tiny-dungeon.png` more than once.

import { useEffect, useRef } from "react";
import {
  TILESET_URL,
  buildCharacterSheetFromTile,
  DEFAULT_CHARACTER_TILE,
} from "../game/pixelArt";

// Promise that resolves once to the loaded tileset image.
let tilemapPromise: Promise<HTMLImageElement> | null = null;
function getTilemap(): Promise<HTMLImageElement> {
  if (tilemapPromise) return tilemapPromise;
  tilemapPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("SSR: no window"));
      return;
    }
    const img = new Image();
    img.src = TILESET_URL;
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
  });
  return tilemapPromise;
}

interface NpcAvatarProps {
  baseTile?: number;
  tint: { l?: string; L?: string; d?: string };
  size?: number; // css pixel size, default 40
  className?: string;
}

export default function NpcAvatar({
  baseTile,
  tint,
  size = 40,
  className = "",
}: NpcAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTilemap()
      .then((img) => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        // Build the 8-frame sheet for this base tile + tint, then paint just
        // the first (down_0) frame to the destination canvas.
        const sheet = buildCharacterSheetFromTile(
          img,
          baseTile ?? DEFAULT_CHARACTER_TILE,
          tint,
        );
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // Draw the 16×16 down_0 frame (top-left of the sheet) into the
        // canvas's native 16×16 surface. CSS upscales from there.
        ctx.drawImage(
          sheet,
          0, 0, 16, 16,
          0, 0, 16, 16,
        );
      })
      .catch(() => {
        // ignore — we'll just render a blank tinted box as fallback
      });
    return () => {
      cancelled = true;
    };
  }, [baseTile, tint.l, tint.L, tint.d]);

  return (
    <canvas
      ref={canvasRef}
      width={16}
      height={16}
      className={`pixelated rounded border-2 border-ink ${className}`}
      style={{
        width: size,
        height: size,
        background: tint.L ?? "#9bbc0f",
        imageRendering: "pixelated",
      }}
    />
  );
}
