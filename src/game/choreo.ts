// Per-tool choreography for dynamic NPCs.
//
// When an NPC finishes walking to a room in response to a real Claude tool
// call (Read, Edit, Bash, etc.), we play a short looping animation at the
// destination tile that tells the player what the agent is doing. A single
// handle controls the lifetime — calling `stop()` cancels the tween, destroys
// the floating emoji, and restores the sprite to its baseline pose.

import Phaser from "phaser";
import { TILE_SIZE } from "./palette";

export type ChoreoKind =
  | "idle-bob"
  | "reading"
  | "typing"
  | "hammering"
  | "searching"
  | "browsing"
  | "pondering"
  | "planning"
  | "directing";

/**
 * Map a Claude tool name (from transcript `tool_use.name`) to a choreo kind.
 */
export function toolNameToChoreo(toolName: string | undefined): ChoreoKind {
  switch (toolName) {
    case "Read":
      return "reading";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "typing";
    case "Bash":
      return "hammering";
    case "Grep":
    case "Glob":
      return "searching";
    case "WebFetch":
    case "WebSearch":
      return "browsing";
    case "Task":
      return "directing";
    case "TodoWrite":
      return "planning";
    default:
      return "pondering";
  }
}

const EMOJI_FOR_CHOREO: Partial<Record<ChoreoKind, string>> = {
  reading: "📖",
  typing: "⌨️",
  hammering: "🔧",
  searching: "🔍",
  browsing: "🌐",
  pondering: "💭",
  planning: "✓",
  directing: "📜",
  // "idle-bob" has no floating emoji.
};

export interface ChoreoTarget {
  sprite: Phaser.GameObjects.Sprite;
}

export interface ChoreoHandle {
  stop: () => void;
}

// Frame constants (mirror CHAR_FRAME in pixelArt.ts — 0..7 layout).
const FRAME_DOWN_0 = 0;
const FRAME_UP_0 = 2;
const FRAME_LEFT_0 = 4;
const FRAME_RIGHT_0 = 6;

/**
 * Start a choreo on a sprite. Returns a handle whose `stop()` tears down
 * every side-effect (tweens, floating emojis, timers). Safe to call stop()
 * more than once.
 */
export function startChoreo(
  scene: Phaser.Scene,
  target: ChoreoTarget,
  kind: ChoreoKind,
): ChoreoHandle {
  const sprite = target.sprite;
  const tweens: Phaser.Tweens.Tween[] = [];
  const textObjs: Phaser.GameObjects.Text[] = [];
  const timers: Phaser.Time.TimerEvent[] = [];

  // Capture baseline scale before overriding — sub-agent sprites rest at 0.8.
  // All scale tweens below are relative to this baseline so we don't snap
  // the sprite back to 1× when a choreo starts.
  const rsx = sprite.scaleX || 1;
  const rsy = sprite.scaleY || 1;
  /** Scale a choreo "ratio" (e.g. 0.97 for breathing) by the resting scale. */
  const rx = (ratio: number) => rsx * ratio;
  const ry = (ratio: number) => rsy * ratio;

  // Reset any legacy pose (angle/alpha only — scale is preserved).
  sprite.setAngle(0);
  sprite.setAlpha(1);

  // Floating emoji helper — positions at the upper-RIGHT of the sprite so it
  // doesn't collide with the overhead text bubble that the scene draws above
  // NPCs when an activity fires.
  let emojiText: Phaser.GameObjects.Text | null = null;
  const EMOJI_X_OFFSET = TILE_SIZE / 2 + 1; // right of the sprite
  const EMOJI_Y_OFFSET = TILE_SIZE / 2 + 2; // slightly above baseline
  const floatEmoji = (
    emoji: string,
    {
      persistent,
      size,
    }: { persistent: boolean; size?: number; yOffset?: number } = {
      persistent: true,
    },
  ) => {
    const t = scene.add
      .text(sprite.x + EMOJI_X_OFFSET, sprite.y - EMOJI_Y_OFFSET, emoji, {
        fontSize: `${size ?? 9}px`,
        resolution: 3,
      })
      .setOrigin(0, 1)
      .setDepth(sprite.depth + 200);
    textObjs.push(t);

    // Gentle up-tween so the emoji pops in with a small lift.
    tweens.push(
      scene.tweens.add({
        targets: t,
        y: { from: t.y + 4, to: t.y },
        alpha: { from: 0, to: 1 },
        duration: 180,
        ease: "Back.easeOut",
      }),
    );

    if (!persistent) {
      timers.push(
        scene.time.delayedCall(1200, () => {
          tweens.push(
            scene.tweens.add({
              targets: t,
              alpha: 0,
              y: t.y - 6,
              duration: 240,
              onComplete: () => t.destroy(),
            }),
          );
        }),
      );
    }

    // Re-anchor the emoji each frame above the sprite (cheap, only while alive).
    const onUpdate = () => {
      if (!t.scene) return;
      t.x = sprite.x + EMOJI_X_OFFSET;
      t.y = sprite.y - EMOJI_Y_OFFSET;
    };
    scene.events.on(Phaser.Scenes.Events.UPDATE, onUpdate);
    const dispose = () => scene.events.off(Phaser.Scenes.Events.UPDATE, onUpdate);
    t.once(Phaser.GameObjects.Events.DESTROY, dispose);
    return t;
  };

  const setFrameIfExists = (frame: number) => {
    try {
      sprite.setFrame(frame);
    } catch {
      // Ignore — spritesheet may not have this frame (shouldn't happen).
    }
  };

  switch (kind) {
    case "idle-bob": {
      // scaleY breathing — never touches x/y so the walk tween has sole
      // ownership of position. Avoids the "jumping while walking" bug.
      tweens.push(
        scene.tweens.add({
          targets: sprite,
          scaleY: { from: ry(1), to: ry(0.97) },
          duration: 1100,
          yoyo: true,
          repeat: -1,
          ease: "Sine.easeInOut",
        }),
      );
      break;
    }

    case "reading": {
      // NPC "looks at shelf": left-facing; subtle horizontal squash instead
      // of x-position sway (x tweens would fight the walk tween).
      setFrameIfExists(FRAME_LEFT_0);
      tweens.push(
        scene.tweens.add({
          targets: sprite,
          scaleX: { from: rx(1), to: rx(0.94) },
          duration: 500,
          yoyo: true,
          repeat: -1,
          ease: "Sine.easeInOut",
        }),
      );
      emojiText = floatEmoji(EMOJI_FOR_CHOREO.reading!, { persistent: true });
      break;
    }

    case "typing": {
      // Faces the desk. Rapid scaleY pulse to read as "tapping keys".
      setFrameIfExists(FRAME_DOWN_0);
      tweens.push(
        scene.tweens.add({
          targets: sprite,
          scaleY: { from: ry(1), to: ry(0.95) },
          duration: 180,
          yoyo: true,
          repeat: -1,
          ease: "Sine.easeInOut",
        }),
      );
      emojiText = floatEmoji(EMOJI_FOR_CHOREO.typing!, { persistent: true });
      break;
    }

    case "hammering": {
      // At the anvil. Strong scaleY pulse reads as swinging a hammer without
      // actually moving the sprite position (which would fight walk tweens).
      setFrameIfExists(FRAME_DOWN_0);
      tweens.push(
        scene.tweens.add({
          targets: sprite,
          scaleY: { from: ry(1), to: ry(0.88) },
          duration: 160,
          yoyo: true,
          repeat: -1,
          ease: "Sine.easeInOut",
        }),
      );
      emojiText = floatEmoji(EMOJI_FOR_CHOREO.hammering!, { persistent: true });
      break;
    }

    case "searching": {
      // Rotate through the 4 directions as if scanning shelves.
      let step = 0;
      const cycle = [FRAME_DOWN_0, FRAME_RIGHT_0, FRAME_UP_0, FRAME_LEFT_0];
      timers.push(
        scene.time.addEvent({
          delay: 300,
          loop: true,
          callback: () => {
            setFrameIfExists(cycle[step % cycle.length]);
            step += 1;
          },
        }),
      );
      emojiText = floatEmoji(EMOJI_FOR_CHOREO.searching!, { persistent: true });
      break;
    }

    case "browsing": {
      setFrameIfExists(FRAME_DOWN_0);
      tweens.push(
        scene.tweens.add({
          targets: sprite,
          alpha: { from: 1, to: 0.8 },
          duration: 500,
          yoyo: true,
          repeat: -1,
          ease: "Sine.easeInOut",
        }),
      );
      emojiText = floatEmoji(EMOJI_FOR_CHOREO.browsing!, { persistent: true });
      break;
    }

    case "pondering": {
      // Slow tween between facing-down and facing-up.
      let up = false;
      timers.push(
        scene.time.addEvent({
          delay: 800,
          loop: true,
          callback: () => {
            up = !up;
            setFrameIfExists(up ? FRAME_UP_0 : FRAME_DOWN_0);
          },
        }),
      );
      emojiText = floatEmoji(EMOJI_FOR_CHOREO.pondering!, { persistent: true });
      break;
    }

    case "planning": {
      // Quick flashes of a checkmark, then a soft scaleY bob.
      setFrameIfExists(FRAME_DOWN_0);
      let flashes = 0;
      const doFlash = () => {
        floatEmoji(EMOJI_FOR_CHOREO.planning!, {
          persistent: false,
          size: 12,
        });
        flashes += 1;
        if (flashes < 3) {
          timers.push(scene.time.delayedCall(400, doFlash));
        }
      };
      doFlash();
      tweens.push(
        scene.tweens.add({
          targets: sprite,
          scaleY: { from: ry(1), to: ry(0.97) },
          duration: 1100,
          yoyo: true,
          repeat: -1,
          ease: "Sine.easeInOut",
        }),
      );
      break;
    }

    case "directing": {
      // Faces its helper. Scale-based pulses (no position tween).
      setFrameIfExists(FRAME_DOWN_0);
      tweens.push(
        scene.tweens.add({
          targets: sprite,
          scaleX: { from: rx(1), to: rx(1.03) },
          duration: 400,
          yoyo: true,
          repeat: -1,
          ease: "Sine.easeInOut",
        }),
      );
      tweens.push(
        scene.tweens.add({
          targets: sprite,
          scaleY: { from: ry(1), to: ry(0.95) },
          duration: 700,
          yoyo: true,
          repeat: -1,
          ease: "Sine.easeInOut",
        }),
      );
      emojiText = floatEmoji(EMOJI_FOR_CHOREO.directing!, { persistent: true });
      break;
    }
  }

  return {
    stop: () => {
      for (const tw of tweens) {
        try {
          tw.stop();
          tw.remove();
        } catch {
          // ignore
        }
      }
      for (const ti of timers) {
        try {
          ti.remove(false);
        } catch {
          // ignore
        }
      }
      if (emojiText) {
        try {
          emojiText.destroy();
        } catch {
          // ignore
        }
        emojiText = null;
      }
      for (const t of textObjs) {
        try {
          t.destroy();
        } catch {
          // ignore
        }
      }
      // Restore the sprite to its resting pose — resting scale captured at
      // start() preserves sub-agent 0.8× shrink across choreo changes.
      try {
        sprite.setScale(rsx, rsy);
        sprite.setAngle(0);
        sprite.setAlpha(1);
      } catch {
        // ignore — sprite may have been destroyed already
      }
    },
  };
}
