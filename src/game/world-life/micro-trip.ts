// World-life Stage 4b — micro-trip visual module (spec §4).
//
// A micro-trip is a short out-and-back visit to an adjacent room
// (graph-distance 1). The NPC picks a neighbour, carries a prop
// (mug / notebook / clipboard / folder) so the return reads as
// "same task continuing", walks there, hangs out for a jittered
// duration, then walks back to their home seat. On return a tiny
// poof (✨) marks the beat.
//
// Hard-interrupt rule: a tool_event mid-trip calls `handle.stop()`.
// The prop is destroyed instantly and the NPC stays wherever it is —
// the FSM transitions to ACTIVE_TOOL which re-seats via its own path.
//
// No stacking: the caller gates entry behind MICRO_COOLDOWN_S.
//
// Break variant (options.isBreak): uses BREAK_DURATION_S for the hang-
// out time and preferentially targets a lounge room.

import Phaser from "phaser";

import { TILE_SIZE } from "../palette";
import { WORLD_LIFE_TUNABLES } from "./tunables";

// --------------------------------------------------------------------
// Carry-prop palette
// --------------------------------------------------------------------

const CARRY_PROPS = ["📋", "☕", "📓", "🗂️"] as const;

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------

export interface MicroTripCallbacks {
  /** Walk the NPC to a target cell. Resolves on arrival. */
  walkTo(col: number, row: number): Promise<void>;
  /** Get NPC's current cell. */
  getPos(): { col: number; row: number };
  /** Get the NPC's home seat (where they return to). */
  getHomeSeat(): { col: number; row: number } | null;
  /** Get adjacent room anchors (graph-distance 1 from current room). */
  getAdjacentRooms(): Array<{ roomId: string; col: number; row: number }>;
}

export interface MicroTripHandle {
  /** Hard-stop: tool event preemption. Kills prop, NPC stays where they are. */
  stop(): void;
  /** True when the trip has completed (returned to home seat). */
  readonly done: boolean;
  /** The room the NPC went to. */
  readonly targetRoom: string | null;
}

// --------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------

/**
 * Start a micro-trip for an NPC.
 *
 * @param scene  - The Phaser scene (for tweens/timers/text objects)
 * @param sprite - The NPC's sprite
 * @param callbacks - walkTo/getPos/getHomeSeat/getAdjacentRooms
 * @param options - `isBreak` uses longer hangout and prefers lounge
 */
export function startMicroTrip(
  scene: Phaser.Scene,
  sprite: Phaser.GameObjects.Sprite,
  callbacks: MicroTripCallbacks,
  options?: { isBreak?: boolean },
): MicroTripHandle {
  let stopped = false;
  let done = false;
  let targetRoom: string | null = null;

  // Cleanup tracking
  const timers: Phaser.Time.TimerEvent[] = [];
  const tweens: Phaser.Tweens.Tween[] = [];
  let propOverlay: Phaser.GameObjects.Text | null = null;
  let propFollowDispose: (() => void) | null = null;

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  const cleanup = () => {
    for (const ti of timers) {
      try { ti.remove(false); } catch { /* ignore */ }
    }
    timers.length = 0;
    for (const tw of tweens) {
      try { tw.stop(); tw.remove(); } catch { /* ignore */ }
    }
    tweens.length = 0;
    destroyProp();
  };

  const destroyProp = () => {
    if (propFollowDispose) {
      propFollowDispose();
      propFollowDispose = null;
    }
    if (propOverlay) {
      try { propOverlay.destroy(); } catch { /* ignore */ }
      propOverlay = null;
    }
  };

  const finish = () => {
    if (done) return;
    done = true;
    cleanup();
  };

  // ------------------------------------------------------------------
  // Create carry-prop overlay (follows sprite each frame)
  // ------------------------------------------------------------------

  const createProp = () => {
    if (!sprite.scene) return;
    const emoji = pickRandom(CARRY_PROPS);
    propOverlay = scene.add
      .text(sprite.x + TILE_SIZE / 2, sprite.y - 4, emoji, {
        fontSize: "9px",
        resolution: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(sprite.depth + 150);

    const onUpdate = () => {
      if (!propOverlay || !propOverlay.scene) return;
      propOverlay.x = sprite.x + TILE_SIZE / 2;
      propOverlay.y = sprite.y - 4;
    };
    scene.events.on(Phaser.Scenes.Events.UPDATE, onUpdate);
    propFollowDispose = () => {
      scene.events.off(Phaser.Scenes.Events.UPDATE, onUpdate);
    };
  };

  // ------------------------------------------------------------------
  // Exit beat: small poof (✨, 300ms fade) on return
  // ------------------------------------------------------------------

  const playExitBeat = (cb: () => void) => {
    if (stopped || !sprite.scene) { cb(); return; }
    const poof = scene.add
      .text(sprite.x, sprite.y - TILE_SIZE, "✨", {
        fontSize: "10px",
        resolution: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(sprite.depth + 200)
      .setAlpha(1);

    const tw = scene.tweens.add({
      targets: poof,
      alpha: { from: 1, to: 0 },
      y: { from: poof.y, to: poof.y - 10 },
      duration: 300,
      ease: "Sine.easeOut",
      onComplete: () => {
        try { poof.destroy(); } catch { /* ignore */ }
        cb();
      },
    });
    tweens.push(tw);
  };

  // ------------------------------------------------------------------
  // Room selection
  // ------------------------------------------------------------------

  const adjacentRooms = callbacks.getAdjacentRooms();
  if (adjacentRooms.length === 0) {
    // No adjacent rooms — abort immediately
    done = true;
    const handle: MicroTripHandle = {
      stop() { /* no-op */ },
      get done() { return true; },
      get targetRoom() { return null; },
    };
    return handle;
  }

  // Break variant: prefer lounge room
  let chosen: { roomId: string; col: number; row: number };
  if (options?.isBreak) {
    const lounge = adjacentRooms.find((r) =>
      r.roomId.toLowerCase().includes("lounge"),
    );
    chosen = lounge ?? pickRandom(adjacentRooms);
  } else {
    chosen = pickRandom(adjacentRooms);
  }
  targetRoom = chosen.roomId;

  // ------------------------------------------------------------------
  // Hangout duration (jittered)
  // ------------------------------------------------------------------

  const durationRange = options?.isBreak
    ? WORLD_LIFE_TUNABLES.BREAK_DURATION_S
    : WORLD_LIFE_TUNABLES.MICRO_DURATION_S;
  const [lo, hi] = durationRange;
  const hangoutMs = (lo + Math.random() * (hi - lo)) * 1000;

  // ------------------------------------------------------------------
  // Async orchestration
  // ------------------------------------------------------------------

  const run = async () => {
    if (stopped) return;

    const homeSeat = callbacks.getHomeSeat();

    // 1. Attach carry-prop
    createProp();

    // 2. Walk to target room
    try {
      await callbacks.walkTo(chosen.col, chosen.row);
    } catch {
      // Walk failed (blocked, preempted) — abort gracefully
      finish();
      return;
    }
    if (stopped) return;

    // 3. Hang out (jittered duration)
    await new Promise<void>((resolve) => {
      const timer = scene.time.delayedCall(hangoutMs, () => {
        resolve();
      });
      timers.push(timer);
    });
    if (stopped) return;

    // 4. Walk back to home seat
    if (homeSeat) {
      try {
        await callbacks.walkTo(homeSeat.col, homeSeat.row);
      } catch {
        // Walk back failed — still finish
      }
    }
    if (stopped) return;

    // 5. Destroy prop before exit beat
    destroyProp();

    // 6. Exit beat (✨ poof)
    playExitBeat(() => {
      finish();
    });
  };

  // Kick off (fire-and-forget; errors won't propagate)
  run();

  // ------------------------------------------------------------------
  // Handle
  // ------------------------------------------------------------------

  const handle: MicroTripHandle = {
    get done() {
      return done;
    },
    get targetRoom() {
      return targetRoom;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cleanup();
      done = true;
    },
  };

  return handle;
}
