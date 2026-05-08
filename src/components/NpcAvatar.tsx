"use client";

// NpcAvatar — renders a 16×16 down-facing pixel-art preview of an NPC
// using the same Limezu Modern character sheet the Phaser scene picks
// for that id. We hash the id to one of the four available characters
// so the roster icon matches what's on the map.

import { useEffect, useRef } from "react";

const MODERN_CHARS = ["Adam", "Alex", "Amelia", "Bob"] as const;
type ModernChar = (typeof MODERN_CHARS)[number];

function characterFor(id: string): ModernChar {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  return MODERN_CHARS[Math.abs(h) % MODERN_CHARS.length];
}

const sheetCache = new Map<ModernChar, Promise<HTMLImageElement>>();
function getSheet(c: ModernChar): Promise<HTMLImageElement> {
  const cached = sheetCache.get(c);
  if (cached) return cached;
  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("SSR: no window"));
      return;
    }
    const img = new Image();
    img.src = `/assets/sprites/modern/${c}_run_16x16.png`;
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
  });
  sheetCache.set(c, p);
  return p;
}

interface NpcAvatarProps {
  /** Stable id used to pick a Modern character. */
  id: string;
  size?: number; // css pixel size, default 40
  className?: string;
}

export default function NpcAvatar({
  id,
  size = 40,
  className = "",
}: NpcAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const character = characterFor(id);

  useEffect(() => {
    let cancelled = false;
    getSheet(character)
      .then((img) => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // Frame 0 is the down-facing first frame of the run cycle. The
        // sheet is 16w × 32h per frame (full body, head + torso).
        ctx.drawImage(img, 0, 0, 16, 32, 0, 0, 16, 32);
      })
      .catch(() => {
        // ignore — leave the canvas blank
      });
    return () => {
      cancelled = true;
    };
  }, [character]);

  return (
    <canvas
      ref={canvasRef}
      width={16}
      height={32}
      className={`pixelated rounded border-2 border-ink ${className}`}
      style={{
        width: size / 2,
        height: size,
        background: "var(--paper-dim)",
        imageRendering: "pixelated",
      }}
    />
  );
}
