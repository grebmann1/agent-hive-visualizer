// World-life Stage 3 — idle micro-animations (spec §5).
//
// 12-action catalog + per-NPC ticker that rolls the spec frequency table
// every IDLE_TICK_S seconds (jittered ±JITTER). One animation channel
// per NPC: a micro-action pre-empts the signature loop and never
// overlaps another micro-action. Particle overlays (`z`, ♪, `!`) live
// on a separate Phaser layer above the sprite.
//
// All driven by the `worldLifeV2` flag in WorldScene; with the flag off
// none of this code runs. Visual side effects are confined to:
//   1. Sprite tween (scaleX/scaleY/angle) on the NPC's existing sprite.
//   2. Optional prop overlay (Phaser.Text) at depth = sprite.depth + 1.
//   3. Optional particle text at depth = sprite.depth + 2 that floats
//      up + fades.
// The sprite's frame is left alone — the channel restores `scaleX/Y/angle`
// to the values captured at start-time when the tween completes.

import Phaser from "phaser";

import { TILE_SIZE } from "../palette";
import type { RoomId } from "../../events/types";
import { WORLD_LIFE_TUNABLES } from "./tunables";
import { worldLifeDebug, type WorldLifeState } from "./state-machine";

// --------------------------------------------------------------------
// Catalog (spec §5 table)
// --------------------------------------------------------------------

export type IdleContext =
  | "any"
  | "standing"
  | "seated"
  | "lounge"
  | "desk"
  | "library"
  | "garden";

export interface IdleAnimDef {
  /** Stable identifier; logged on play. */
  name: string;
  /** Total duration in milliseconds. */
  durationMs: number;
  /** Optional held prop emoji (☕, 📄, 📱…). Rendered at hand offset. */
  prop?: string;
  /** Optional particle emoji (z, ♪, !). Floats up + fades above sprite. */
  emoji?: string;
  /** Allowed contexts. `"any"` matches every room/posture. */
  contexts: IdleContext[];
}

/** 12 micro-actions, verb-first, prop-second, emoji-last. Order matches
 *  spec §5 so #5 / #10 are the "prop micro" bucket and #6 / #7 are the
 *  glance/watch bucket the frequency table indexes by. */
export const IDLE_ANIMS: readonly IdleAnimDef[] = [
  { name: "stretch-arms",       durationMs: 1200, contexts: ["standing"] },
  { name: "yawn",               durationMs: 800,  emoji: "z",       contexts: ["any"] },
  { name: "shift-weight",       durationMs: 600,                    contexts: ["standing"] },
  { name: "scratch-head",       durationMs: 700,                    contexts: ["any"] },
  { name: "sip-mug",            durationMs: 2000, prop: "☕", contexts: ["lounge", "desk", "library"] },
  { name: "check-watch",        durationMs: 600,  prop: "⏱", contexts: ["any"] },
  { name: "glance-around",      durationMs: 900,                    contexts: ["any"] },
  { name: "doze-nod",           durationMs: 1400, emoji: "z",       contexts: ["seated"] },
  { name: "phone-buzz",         durationMs: 1000, prop: "📱", emoji: "!", contexts: ["any"] },
  { name: "page-flip",          durationMs: 800,  prop: "📄", contexts: ["desk", "library"] },
  { name: "pet-cat",            durationMs: 1500, prop: "🐈", contexts: ["lounge", "garden"] },
  { name: "hum-notes",          durationMs: 1000, emoji: "♪", contexts: ["any"] },
] as const;

// --------------------------------------------------------------------
// Frequency table (spec §5)
// --------------------------------------------------------------------

type Bucket =
  | "noop"
  | "fidget"     // #1–4
  | "signature"  // delegate to Stage 2
  | "prop"       // #5, #10
  | "glance"     // #6, #7
  | "doze"       // #8 — seated only
  | "rare";      // #9, #11, #12

interface BucketRow {
  bucket: Bucket;
  threshold: number; // cumulative
}

const BUCKET_TABLE: readonly BucketRow[] = [
  { bucket: "noop",      threshold: 0.35 },
  { bucket: "fidget",    threshold: 0.60 },
  { bucket: "signature", threshold: 0.75 },
  { bucket: "prop",      threshold: 0.85 },
  { bucket: "glance",    threshold: 0.93 },
  { bucket: "doze",      threshold: 0.98 },
  { bucket: "rare",      threshold: 1.00 },
] as const;

function rollBucket(): Bucket {
  const r = Math.random();
  for (const row of BUCKET_TABLE) {
    if (r < row.threshold) return row.bucket;
  }
  return "noop";
}

const FIDGET_INDICES = [0, 1, 2, 3] as const;
const PROP_INDICES   = [4, 9] as const;       // sip-mug, page-flip
const GLANCE_INDICES = [5, 6] as const;       // check-watch, glance-around
const RARE_INDICES   = [8, 10, 11] as const;  // phone-buzz, pet-cat, hum-notes
const DOZE_INDEX     = 7;                     // doze-nod

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --------------------------------------------------------------------
// Reduced-motion (module-load + listener)
// --------------------------------------------------------------------

let reducedMotion = false;

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion = mql.matches;
  const onChange = (e: MediaQueryListEvent) => {
    reducedMotion = e.matches;
  };
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
  } else if (typeof (mql as MediaQueryList & { addListener?: (cb: (e: MediaQueryListEvent) => void) => void }).addListener === "function") {
    (mql as MediaQueryList & { addListener: (cb: (e: MediaQueryListEvent) => void) => void }).addListener(onChange);
  }
}

export function isReducedMotion(): boolean {
  return reducedMotion;
}

// --------------------------------------------------------------------
// Phase offset (spec §5 rule 3)
// --------------------------------------------------------------------

/** Stable hash → 0..999 ms phase offset so 6 NPCs in a room don't yawn
 *  in unison. djb2 over the id, modulo 1000. */
export function phaseOffsetMs(npcId: string): number {
  let h = 5381;
  for (let i = 0; i < npcId.length; i++) {
    h = ((h << 5) + h + npcId.charCodeAt(i)) & 0x7fffffff;
  }
  return h % 1000;
}

// --------------------------------------------------------------------
// Per-NPC channel state
// --------------------------------------------------------------------

interface IdleChannel {
  /** Scene-clock ms when the next tick fires. */
  nextTickAt: number;
  /** Scene-clock ms when the current micro-action ends (0 if idle). */
  busyUntil: number;
  /** Scene-clock ms of the last micro-action's end (for IDLE_MIN_GAP_S). */
  lastEndAt: number;
  /** Scene-clock ms of the last prop micro's end (for IDLE_PROP_GAP_S). */
  lastPropEndAt: number;
  /** Active tween, if any — killed on pre-empt. */
  activeTween?: Phaser.Tweens.Tween;
  /** Active prop/particle text overlays — destroyed on pre-empt. */
  activeOverlays: Phaser.GameObjects.GameObject[];
  /** Scaled-up baseline scaleX/Y/angle so the channel can restore them. */
  baseline?: { scaleX: number; scaleY: number; angle: number };
  /** Scene-clock ms when the most recent suspension fired (pause rule). */
  suspendedAt: number;
}

function makeChannel(now: number, offsetMs: number): IdleChannel {
  return {
    nextTickAt: now + offsetMs + jitteredTickMs(),
    busyUntil: 0,
    lastEndAt: 0,
    lastPropEndAt: 0,
    activeOverlays: [],
    suspendedAt: 0,
  };
}

function jitteredTickMs(): number {
  const [lo, hi] = WORLD_LIFE_TUNABLES.IDLE_TICK_S;
  const baseMs = (lo + Math.random() * (hi - lo)) * 1000;
  const j = WORLD_LIFE_TUNABLES.JITTER;
  const factor = 1 + (Math.random() * 2 - 1) * j;
  return baseMs * factor;
}

// --------------------------------------------------------------------
// IdleAnimController — owns one channel per NPC, drives the per-frame ticker
// --------------------------------------------------------------------

/** Source of context the controller queries each tick. The owning scene
 *  passes this in so the module stays Phaser-agnostic at the test seam. */
export interface IdleContextProvider {
  /** Sprite the channel animates. Returns undefined → NPC was removed. */
  spriteFor(npcId: string): Phaser.GameObjects.Sprite | undefined;
  /** True iff the NPC is currently seated (occupies a seat cell). */
  isSeated(npcId: string): boolean;
  /** Current room id under the NPC's tile-anchor cell, or null. */
  roomFor(npcId: string): RoomId | null;
  /** True iff the NPC is currently in any of the suspending conditions
   *  (dialog, walking, tool-action, transition, selected-by-user). */
  isSuspended(npcId: string): boolean;
  /** Stage 2 hook — invoked when a "signature-action beat" is rolled.
   *  Returns true if the lounge-signature owned the beat (so we don't
   *  also play a micro-action on the same channel). */
  triggerSignatureBeat?(npcId: string): boolean;
}

const SUSPEND_RESUME_MS = 500; // spec §5 last paragraph: "0.5 s settle delay"

export class IdleAnimController {
  private channels = new Map<string, IdleChannel>();

  constructor(
    private scene: Phaser.Scene,
    private ctx: IdleContextProvider,
  ) {}

  /** Per-frame entry point. WorldScene.update() calls this once. */
  tick(nowMs: number): void {
    if (reducedMotion) return;
    for (const [id, ch] of this.channels) {
      this.tickOne(id, ch, nowMs);
    }
  }

  /** Ensure a channel exists for `npcId`. Idempotent. */
  ensure(npcId: string): void {
    if (this.channels.has(npcId)) return;
    const now = this.scene.time.now;
    this.channels.set(npcId, makeChannel(now, phaseOffsetMs(npcId)));
  }

  /** Drop a channel (NPC despawned). Stops any in-flight tween/overlay. */
  forget(npcId: string): void {
    const ch = this.channels.get(npcId);
    if (!ch) return;
    this.stopChannel(npcId, ch);
    this.channels.delete(npcId);
  }

  /** Tear down all channels — called on scene shutdown. */
  destroy(): void {
    for (const [id, ch] of this.channels) {
      this.stopChannel(id, ch);
    }
    this.channels.clear();
  }

  private tickOne(npcId: string, ch: IdleChannel, nowMs: number): void {
    if (this.ctx.isSuspended(npcId)) {
      if (ch.busyUntil > nowMs && ch.activeTween) {
        this.stopChannel(npcId, ch);
      }
      ch.suspendedAt = nowMs;
      return;
    }
    if (ch.suspendedAt !== 0) {
      if (nowMs - ch.suspendedAt < SUSPEND_RESUME_MS) return;
      ch.suspendedAt = 0;
      ch.nextTickAt = nowMs + jitteredTickMs();
      return;
    }
    if (worldLifeDebug.states[npcId] !== ("ROOM_IDLE" satisfies WorldLifeState)) {
      ch.nextTickAt = nowMs + jitteredTickMs();
      return;
    }
    if (nowMs < ch.nextTickAt) return;
    if (ch.busyUntil > nowMs) return;

    ch.nextTickAt = nowMs + jitteredTickMs();

    if (nowMs - ch.lastEndAt < WORLD_LIFE_TUNABLES.IDLE_MIN_GAP_S * 1000) return;

    const bucket = rollBucket();
    if (bucket === "noop") return;

    if (bucket === "signature") {
      this.ctx.triggerSignatureBeat?.(npcId);
      return;
    }

    const def = this.pickFromBucket(npcId, bucket, ch, nowMs);
    if (!def) return;

    this.play(npcId, ch, def, nowMs);
  }

  private pickFromBucket(
    npcId: string,
    bucket: Bucket,
    ch: IdleChannel,
    nowMs: number,
  ): IdleAnimDef | null {
    const seated = this.ctx.isSeated(npcId);
    const room = this.ctx.roomFor(npcId);
    const standing = !seated;

    const passes = (def: IdleAnimDef): boolean => {
      for (const c of def.contexts) {
        if (c === "any") return true;
        if (c === "standing" && standing) return true;
        if (c === "seated" && seated) return true;
        if (room !== null && c === room) return true;
      }
      return false;
    };

    let candidates: readonly number[];
    switch (bucket) {
      case "fidget":
        candidates = FIDGET_INDICES;
        break;
      case "prop": {
        if (nowMs - ch.lastPropEndAt < WORLD_LIFE_TUNABLES.IDLE_PROP_GAP_S * 1000) {
          return null;
        }
        candidates = PROP_INDICES;
        break;
      }
      case "glance":
        candidates = GLANCE_INDICES;
        break;
      case "doze":
        if (!seated) return null;
        candidates = [DOZE_INDEX];
        break;
      case "rare":
        candidates = RARE_INDICES;
        break;
      default:
        return null;
    }

    const allowed = candidates.filter((i) => passes(IDLE_ANIMS[i]));
    if (allowed.length === 0) return null;
    return IDLE_ANIMS[pick(allowed)];
  }

  private play(
    npcId: string,
    ch: IdleChannel,
    def: IdleAnimDef,
    nowMs: number,
  ): void {
    const sprite = this.ctx.spriteFor(npcId);
    if (!sprite || !sprite.scene) return;

    ch.baseline = {
      scaleX: sprite.scaleX,
      scaleY: sprite.scaleY,
      angle: sprite.angle,
    };

    const onComplete = () => {
      if (ch.baseline && sprite.scene) {
        sprite.setScale(ch.baseline.scaleX, ch.baseline.scaleY);
        sprite.setAngle(ch.baseline.angle);
      }
      this.finishChannel(ch, def, nowMs + def.durationMs);
    };

    const base = ch.baseline;

    let tween: Phaser.Tweens.Tween;
    switch (def.name) {
      case "stretch-arms":
        tween = this.scene.tweens.add({
          targets: sprite,
          scaleY: { from: base.scaleY, to: base.scaleY * 1.08 },
          duration: def.durationMs / 2,
          yoyo: true,
          ease: "Sine.easeInOut",
          onComplete,
        });
        break;
      case "yawn":
        tween = this.scene.tweens.add({
          targets: sprite,
          scaleX: { from: base.scaleX, to: base.scaleX * 1.05 },
          scaleY: { from: base.scaleY, to: base.scaleY * 1.05 },
          duration: def.durationMs / 2,
          yoyo: true,
          ease: "Sine.easeInOut",
          onComplete,
        });
        break;
      case "shift-weight":
        tween = this.scene.tweens.add({
          targets: sprite,
          angle: { from: base.angle, to: base.angle + 3 },
          duration: def.durationMs / 2,
          yoyo: true,
          ease: "Sine.easeInOut",
          onComplete,
        });
        break;
      case "scratch-head":
        tween = this.scene.tweens.add({
          targets: sprite,
          angle: { from: base.angle - 2, to: base.angle + 2 },
          duration: def.durationMs / 4,
          yoyo: true,
          repeat: 1,
          ease: "Sine.easeInOut",
          onComplete,
        });
        break;
      case "glance-around":
        tween = this.scene.tweens.add({
          targets: sprite,
          scaleX: { from: base.scaleX, to: base.scaleX * -1 },
          duration: def.durationMs / 2,
          yoyo: true,
          ease: "Sine.easeInOut",
          onComplete,
        });
        break;
      case "doze-nod":
        tween = this.scene.tweens.add({
          targets: sprite,
          angle: { from: base.angle, to: base.angle + 6 },
          duration: def.durationMs / 2,
          yoyo: true,
          ease: "Sine.easeInOut",
          onComplete,
        });
        break;
      case "check-watch":
      case "phone-buzz":
      case "page-flip":
      case "sip-mug":
      case "pet-cat":
      case "hum-notes":
      default:
        tween = this.scene.tweens.add({
          targets: sprite,
          scaleY: { from: base.scaleY, to: base.scaleY * 0.96 },
          duration: def.durationMs / 2,
          yoyo: true,
          ease: "Sine.easeInOut",
          onComplete,
        });
        break;
    }

    ch.activeTween = tween;
    ch.busyUntil = nowMs + def.durationMs;

    if (def.prop) {
      const t = this.scene.add
        .text(sprite.x + TILE_SIZE / 2 - 2, sprite.y - TILE_SIZE / 2, def.prop, {
          fontSize: "10px",
          resolution: 3,
        })
        .setOrigin(0.5, 1)
        .setDepth(sprite.depth + 1);
      ch.activeOverlays.push(t);
      this.scene.tweens.add({
        targets: t,
        alpha: { from: 0, to: 1 },
        y: { from: t.y + 3, to: t.y },
        duration: 180,
        ease: "Back.easeOut",
      });
      this.scene.time.delayedCall(def.durationMs - 180, () => {
        if (!t.scene) return;
        this.scene.tweens.add({
          targets: t,
          alpha: 0,
          duration: 180,
          onComplete: () => t.destroy(),
        });
      });
    }

    if (def.emoji) {
      const e = this.scene.add
        .text(sprite.x + TILE_SIZE / 4, sprite.y - TILE_SIZE - 2, def.emoji, {
          fontSize: "9px",
          resolution: 3,
          color: "#f4ecd8",
        })
        .setOrigin(0.5, 1)
        .setDepth(sprite.depth + 2);
      ch.activeOverlays.push(e);
      this.scene.tweens.add({
        targets: e,
        alpha: { from: 1, to: 0 },
        y: { from: e.y, to: e.y - 14 },
        duration: Math.max(def.durationMs, 900),
        ease: "Sine.easeOut",
        onComplete: () => e.destroy(),
      });
    }

  }

  private finishChannel(ch: IdleChannel, def: IdleAnimDef, endMs: number): void {
    ch.activeTween = undefined;
    ch.busyUntil = 0;
    ch.lastEndAt = endMs;
    if (def === IDLE_ANIMS[4] || def === IDLE_ANIMS[9]) {
      ch.lastPropEndAt = endMs;
    }
  }

  private stopChannel(npcId: string, ch: IdleChannel): void {
    if (ch.activeTween) {
      ch.activeTween.stop();
      ch.activeTween = undefined;
    }
    for (const obj of ch.activeOverlays) {
      try {
        obj.destroy();
      } catch {
        // ignore
      }
    }
    ch.activeOverlays = [];
    ch.busyUntil = 0;
    if (ch.baseline) {
      const sprite = this.ctx.spriteFor(npcId);
      if (sprite && sprite.scene) {
        sprite.setScale(ch.baseline.scaleX, ch.baseline.scaleY);
        sprite.setAngle(ch.baseline.angle);
      }
    }
  }
}
