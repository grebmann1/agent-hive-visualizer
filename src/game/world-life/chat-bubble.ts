// Chat-bubble renderer for the World Life chit-chat feature (spec §6 Visual).
//
// Renders a rounded speech bubble anchored to the SIDE of an agent sprite
// (never above the head — that space belongs to the tool pill). Displays 1–2
// emoji, animates in with a 4px tail bob ("Sims plumbob" feel), holds, then
// fades out and self-destructs.

import Phaser from "phaser";
import { TILE_SIZE } from "../palette";

// --------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------

const BUBBLE_HEIGHT = 28;
const BUBBLE_PADDING_X = 8;
const BUBBLE_RADIUS = 6;
const FADE_IN_MS = 350;
const HOLD_MS = 1800;
const FADE_OUT_MS = 250;
const TAIL_BOB_PX = 4;
const BG_COLOR = 0xf4ecd8;
const BG_ALPHA = 0.92;
const OUTLINE_COLOR = 0x2b2b33;
const OUTLINE_WIDTH = 1;

// Tail triangle dimensions
const TAIL_WIDTH = 5;
const TAIL_HEIGHT = 4;

// --------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------

export interface ChatBubbleOptions {
  /** The emoji string to display (1–2 emoji). */
  emoji: string;
  /** The sprite this bubble is attached to. */
  sprite: Phaser.GameObjects.Sprite;
  /** Which side to anchor: "left" or "right". */
  side: "left" | "right";
}

export interface ChatBubbleHandle {
  /** Destroy the bubble immediately (hard interrupt). */
  destroy(): void;
  /** True once the full cycle (fade-in + hold + fade-out) has completed. */
  readonly done: boolean;
}

// --------------------------------------------------------------------
// Helper: determine bubble side from relative positions
// --------------------------------------------------------------------

/**
 * Determine which side to show a bubble based on relative positions.
 * If the partner is to the right, show bubble on the left (facing partner).
 */
export function bubbleSide(
  spriteX: number,
  partnerX: number,
): "left" | "right" {
  return partnerX > spriteX ? "right" : "left";
}

// --------------------------------------------------------------------
// Main renderer
// --------------------------------------------------------------------

/**
 * Show a chat bubble on the side of an NPC sprite.
 * The bubble auto-destructs after its full timing cycle.
 * Returns a handle for early destruction.
 */
export function showChatBubble(
  scene: Phaser.Scene,
  options: ChatBubbleOptions,
): ChatBubbleHandle {
  const { emoji, sprite, side } = options;

  // -- Measure emoji text to determine bubble width -----------------
  const emojiText = scene.add.text(0, 0, emoji, {
    fontSize: "14px",
    resolution: 2,
  });
  const textWidth = emojiText.width;
  const bubbleWidth = Math.max(
    textWidth + BUBBLE_PADDING_X * 2,
    BUBBLE_HEIGHT, // never narrower than its height
  );

  // -- Draw background + tail with Graphics -------------------------
  const gfx = scene.add.graphics();

  // Rounded rect body
  gfx.fillStyle(BG_COLOR, BG_ALPHA);
  gfx.fillRoundedRect(0, 0, bubbleWidth, BUBBLE_HEIGHT, BUBBLE_RADIUS);
  gfx.lineStyle(OUTLINE_WIDTH, OUTLINE_COLOR, 1);
  gfx.strokeRoundedRect(0, 0, bubbleWidth, BUBBLE_HEIGHT, BUBBLE_RADIUS);

  // Tail triangle — points toward the sprite body
  const tailY = BUBBLE_HEIGHT / 2 - TAIL_HEIGHT / 2;
  if (side === "left") {
    // Tail on right edge, pointing right toward sprite
    const tailX = bubbleWidth;
    gfx.fillStyle(BG_COLOR, BG_ALPHA);
    gfx.fillTriangle(
      tailX,
      tailY,
      tailX + TAIL_WIDTH,
      tailY + TAIL_HEIGHT / 2,
      tailX,
      tailY + TAIL_HEIGHT,
    );
    gfx.lineStyle(OUTLINE_WIDTH, OUTLINE_COLOR, 1);
    gfx.lineBetween(tailX, tailY, tailX + TAIL_WIDTH, tailY + TAIL_HEIGHT / 2);
    gfx.lineBetween(
      tailX + TAIL_WIDTH,
      tailY + TAIL_HEIGHT / 2,
      tailX,
      tailY + TAIL_HEIGHT,
    );
  } else {
    // Tail on left edge, pointing left toward sprite
    const tailX = 0;
    gfx.fillStyle(BG_COLOR, BG_ALPHA);
    gfx.fillTriangle(
      tailX,
      tailY,
      tailX - TAIL_WIDTH,
      tailY + TAIL_HEIGHT / 2,
      tailX,
      tailY + TAIL_HEIGHT,
    );
    gfx.lineStyle(OUTLINE_WIDTH, OUTLINE_COLOR, 1);
    gfx.lineBetween(tailX, tailY, tailX - TAIL_WIDTH, tailY + TAIL_HEIGHT / 2);
    gfx.lineBetween(
      tailX - TAIL_WIDTH,
      tailY + TAIL_HEIGHT / 2,
      tailX,
      tailY + TAIL_HEIGHT,
    );
  }

  // -- Position emoji text centered inside the bubble ---------------
  emojiText.setPosition(
    (bubbleWidth - textWidth) / 2,
    (BUBBLE_HEIGHT - emojiText.height) / 2,
  );

  // -- Assemble container -------------------------------------------
  const container = scene.add.container(0, 0, [gfx, emojiText]);
  container.setAlpha(0);
  container.setDepth((sprite.depth ?? 0) + 100);

  // -- Position updater (follows the sprite each frame) -------------
  function updatePosition(): void {
    const targetX =
      side === "left"
        ? sprite.x - bubbleWidth - 4
        : sprite.x + TILE_SIZE + 4;
    const targetY = sprite.y - 8;
    container.setPosition(targetX, targetY);
  }

  updatePosition();

  scene.events.on("update", updatePosition);

  // -- State ---------------------------------------------------------
  let destroyed = false;
  let _done = false;

  function cleanup(): void {
    if (destroyed) return;
    destroyed = true;
    _done = true;
    scene.events.off("update", updatePosition);
    scene.tweens.killTweensOf(container);
    container.destroy();
  }

  // -- Animation sequence --------------------------------------------
  // Start 4px below target for tail bob
  container.y += TAIL_BOB_PX;

  // Phase 1: Fade-in + tail bob
  scene.tweens.add({
    targets: container,
    alpha: 1,
    y: `-=${TAIL_BOB_PX}`,
    duration: FADE_IN_MS,
    ease: "Back.easeOut",
    onComplete: () => {
      if (destroyed) return;
      // Phase 2: Hold — wait then start fade-out
      scene.time.delayedCall(HOLD_MS, () => {
        if (destroyed) return;
        // Phase 3: Fade-out
        scene.tweens.add({
          targets: container,
          alpha: 0,
          duration: FADE_OUT_MS,
          ease: "Linear",
          onComplete: () => {
            cleanup();
          },
        });
      });
    },
  });

  // -- Handle --------------------------------------------------------
  const handle: ChatBubbleHandle = {
    destroy(): void {
      cleanup();
    },
    get done(): boolean {
      return _done;
    },
  };

  return handle;
}
