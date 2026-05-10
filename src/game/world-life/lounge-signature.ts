// World-life Stage 2 — Lounge room signature action (spec §3).
//
// The lounge's signature is a coffee ritual: walk to the espresso
// machine → 2s pour tween → carry mug back → sip-loop (up to 6s).
// After the loop, the choreo ends with an exit beat (4-frame sparkle).
//
// Mug persistence: the ☕ overlay remains for 10s after the NPC leaves
// the lounge (natural walk-away). If preempted by a tool_event, the
// mug is destroyed immediately. If the agent returns to the lounge
// within the 10s window the timer is cancelled and the mug stays.
//
// Anti-patterns respected:
//   - No teleporting — all movement via walkCallback
//   - No infinite loops — sip phase capped at ~6s
//   - Exit beat — 4-frame sparkle/poof when done

import Phaser from "phaser";
import { TILE_SIZE } from "../palette";
import { type ChoreoHandle, startChoreo } from "../choreo";

// --------------------------------------------------------------------
// Types
// --------------------------------------------------------------------

export interface LoungeSignatureCallbacks {
  /** Walk the NPC to a target cell. Returns a Promise that resolves when
   *  the NPC arrives (path drains). The implementation is provided by
   *  the WorldScene bridge so this module stays decoupled from Phaser
   *  pathfinding. */
  walkTo(col: number, row: number): Promise<void>;
  /** Get the NPC's current position. */
  getPos(): { col: number; row: number };
}

export interface LoungeSignatureHandle {
  /** Hard-stop: kills visuals immediately (tool_event preemption). */
  stop(): void;
  /** Soft-stop: NPC is leaving lounge naturally. Starts mug persistence
   *  timer (10s fade). Returns the persisted-mug handle so the caller
   *  can cancel it if the agent returns. */
  softStop(): PersistedMugHandle | null;
  /** True once the ritual sequence has completed (or was stopped). */
  readonly done: boolean;
}

export interface PersistedMugHandle {
  /** Cancel the 10s decay timer — mug stays alive. */
  cancelDecay(): void;
  /** Hard-destroy the mug now (tool_event while mug is decaying). */
  destroy(): void;
}

// Espresso machine offset within the lounge (relative to lounge anchor).
// Positioned 2 tiles to the right and 1 tile up from the center anchor.
const ESPRESSO_OFFSET = { dCol: 2, dRow: -1 };

// Duration constants (ms)
const POUR_DURATION_MS = 2000;
const SIP_DURATION_MS = 6000;    // max sip phase (capped, not infinite)
const SPARKLE_DURATION_MS = 400; // exit beat (4 frames × 100ms)
const MUG_PERSIST_MS = 10000;    // mug lingers 10s after leaving

// --------------------------------------------------------------------
// Main entry point
// --------------------------------------------------------------------

/**
 * Start the lounge signature action for an NPC.
 *
 * @param scene - The Phaser scene (for tweens/timers/text objects)
 * @param sprite - The NPC's sprite
 * @param anchorCol - Lounge room anchor column
 * @param anchorRow - Lounge room anchor row
 * @param callbacks - walkTo/getPos provided by the WorldScene bridge
 */
export function startLoungeSignature(
  scene: Phaser.Scene,
  sprite: Phaser.GameObjects.Sprite,
  anchorCol: number,
  anchorRow: number,
  callbacks: LoungeSignatureCallbacks,
): LoungeSignatureHandle {
  let stopped = false;
  let done = false;

  // Cleanup tracking
  const tweens: Phaser.Tweens.Tween[] = [];
  const timers: Phaser.Time.TimerEvent[] = [];
  const overlays: Phaser.GameObjects.GameObject[] = [];
  let sipChoreo: ChoreoHandle | null = null;
  let mugOverlay: Phaser.GameObjects.Text | null = null;
  let mugFollowDispose: (() => void) | null = null;

  const cleanup = () => {
    for (const tw of tweens) {
      try { tw.stop(); tw.remove(); } catch { /* ignore */ }
    }
    tweens.length = 0;
    for (const ti of timers) {
      try { ti.remove(false); } catch { /* ignore */ }
    }
    timers.length = 0;
    if (sipChoreo) {
      sipChoreo.stop();
      sipChoreo = null;
    }
    for (const o of overlays) {
      try { o.destroy(); } catch { /* ignore */ }
    }
    overlays.length = 0;
  };

  const destroyMug = () => {
    if (mugFollowDispose) {
      mugFollowDispose();
      mugFollowDispose = null;
    }
    if (mugOverlay) {
      try { mugOverlay.destroy(); } catch { /* ignore */ }
      mugOverlay = null;
    }
  };

  const finish = () => {
    if (done) return;
    done = true;
    cleanup();
  };

  // --- Exit beat: 4-frame sparkle/poof ---
  const playExitBeat = (cb: () => void) => {
    if (stopped || !sprite.scene) { cb(); return; }
    const sparkle = scene.add
      .text(sprite.x, sprite.y - TILE_SIZE, "✨", {
        fontSize: "10px",
        resolution: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(sprite.depth + 200)
      .setAlpha(0);
    overlays.push(sparkle);

    // 4-frame scale pulse: 0→1→1.2→0.8→0 over SPARKLE_DURATION_MS
    const tw = scene.tweens.add({
      targets: sparkle,
      alpha: { from: 0, to: 1 },
      scaleX: { from: 0.5, to: 1.3 },
      scaleY: { from: 0.5, to: 1.3 },
      duration: SPARKLE_DURATION_MS / 2,
      yoyo: true,
      ease: "Sine.easeOut",
      onComplete: () => {
        try { sparkle.destroy(); } catch { /* ignore */ }
        cb();
      },
    });
    tweens.push(tw);
  };

  // --- Pour phase: small scale tween on the sprite ---
  const playPour = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const baseScaleY = sprite.scaleY;
      const tw = scene.tweens.add({
        targets: sprite,
        scaleY: { from: baseScaleY, to: baseScaleY * 0.94 },
        duration: POUR_DURATION_MS / 4,
        yoyo: true,
        repeat: 3,
        ease: "Sine.easeInOut",
        onComplete: () => resolve(),
      });
      tweens.push(tw);
    });
  };

  // --- Create mug overlay (☕) that follows the sprite ---
  const createMug = () => {
    if (!sprite.scene) return;
    mugOverlay = scene.add
      .text(sprite.x + TILE_SIZE / 2 - 2, sprite.y - 2, "☕", {
        fontSize: "9px",
        resolution: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(sprite.depth + 150);

    // Follow the sprite each frame
    const onUpdate = () => {
      if (!mugOverlay || !mugOverlay.scene) return;
      mugOverlay.x = sprite.x + TILE_SIZE / 2 - 2;
      mugOverlay.y = sprite.y - 2;
    };
    scene.events.on(Phaser.Scenes.Events.UPDATE, onUpdate);
    mugFollowDispose = () => {
      scene.events.off(Phaser.Scenes.Events.UPDATE, onUpdate);
    };
  };

  // --- Sip phase: use the sip-coffee choreo (capped at SIP_DURATION_MS) ---
  const playSip = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    return new Promise((resolve) => {
      sipChoreo = startChoreo(scene, { sprite }, "sip-coffee");
      const timer = scene.time.delayedCall(SIP_DURATION_MS, () => {
        if (sipChoreo) {
          sipChoreo.stop();
          sipChoreo = null;
        }
        resolve();
      });
      timers.push(timer);
    });
  };

  // --- Orchestrate the full sequence ---
  const run = async () => {
    if (stopped) return;

    // 1. Walk to espresso machine
    const machineCol = anchorCol + ESPRESSO_OFFSET.dCol;
    const machineRow = anchorRow + ESPRESSO_OFFSET.dRow;
    try {
      await callbacks.walkTo(machineCol, machineRow);
    } catch {
      // Walk failed (blocked, preempted) — abort gracefully
      finish();
      return;
    }
    if (stopped) return;

    // 2. Pour (2s tween)
    await playPour();
    if (stopped) return;

    // 3. Create mug + walk back to original position
    createMug();
    const pos = callbacks.getPos();
    const returnCol = anchorCol;
    const returnRow = anchorRow;
    // Only walk back if we're not already at the anchor
    if (pos.col !== returnCol || pos.row !== returnRow) {
      try {
        await callbacks.walkTo(returnCol, returnRow);
      } catch {
        // Walk back failed — still finish
      }
    }
    if (stopped) return;

    // 4. Sip loop (capped at 6s)
    await playSip();
    if (stopped) return;

    // 5. Exit beat (sparkle)
    playExitBeat(() => {
      finish();
    });
  };

  // Kick off the async sequence (fire-and-forget; errors won't propagate)
  run();

  const handle: LoungeSignatureHandle = {
    get done() {
      return done;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      destroyMug();
      cleanup();
      done = true;
    },
    softStop() {
      if (stopped || !mugOverlay) return null;
      stopped = true;
      // Stop the sip choreo but keep the mug alive for 10s
      cleanup();
      done = true;

      // Mug persistence: fade out after MUG_PERSIST_MS
      const mug = mugOverlay;
      const disposeFn = mugFollowDispose;
      let decayTimer: Phaser.Time.TimerEvent | null = null;

      decayTimer = scene.time.delayedCall(MUG_PERSIST_MS, () => {
        if (!mug.scene) return;
        scene.tweens.add({
          targets: mug,
          alpha: 0,
          duration: 300,
          onComplete: () => {
            if (disposeFn) disposeFn();
            try { mug.destroy(); } catch { /* ignore */ }
          },
        });
      });

      // Null out our references since persistence is now self-managed
      mugOverlay = null;
      mugFollowDispose = null;

      return {
        cancelDecay() {
          if (decayTimer) {
            try { decayTimer.remove(false); } catch { /* ignore */ }
            decayTimer = null;
          }
        },
        destroy() {
          if (decayTimer) {
            try { decayTimer.remove(false); } catch { /* ignore */ }
            decayTimer = null;
          }
          if (disposeFn) disposeFn();
          try { mug.destroy(); } catch { /* ignore */ }
        },
      };
    },
  };

  return handle;
}
