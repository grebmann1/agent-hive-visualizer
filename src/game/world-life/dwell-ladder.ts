// Dwell ladder (spec §4).
//
// Pure logic module — no Phaser dependencies. Consumed by the
// WorldScene evaluator (tickWorldLife) to determine what idle behavior
// an NPC should exhibit based on how long they've remained in one room
// without new tool events.
//
// Stages progress monotonically (S0→S1→...→S5) unless a reset fires.
// The module exposes a per-NPC tracker that handles freeze/resume,
// stage-bump-back on same-room tool events, and S5 alternation.

import { WORLD_LIFE_TUNABLES } from "./tunables";

// --------------------------------------------------------------------
// Types
// --------------------------------------------------------------------

export type DwellStage = "S0" | "S1" | "S2" | "S3" | "S4" | "S5";

export interface NpcDwell {
  /** Wall-clock ms when this NPC's dwell started (resets on tool event / room change). */
  dwellStartMs: number;
  /** Current stage (derived from dwellS, but cached for change detection). */
  stage: DwellStage;
  /** Wall-clock ms of the last S2 side-action for this NPC (for 12–18s spacing). */
  lastSideActionMs: number;
  /** Wall-clock ms of the last micro-trip for this NPC. */
  lastMicroTripMs: number;
  /** Wall-clock ms of the last break for this NPC. */
  lastBreakMs: number;
  /** True if frozen (dialog). Dwell pauses. */
  frozen: boolean;
  /** How much dwell had elapsed when frozen (to resume from). */
  frozenElapsedMs: number;
  /** For S5 alternation: last completed substage. */
  lastS5Sub: "trip" | "break" | null;
}

// --------------------------------------------------------------------
// Pure stage classifier
// --------------------------------------------------------------------

/** Classify dwell time (in seconds) into a stage. Pure function. */
export function dwellStage(dwellS: number): DwellStage {
  if (dwellS < WORLD_LIFE_TUNABLES.SETTLE_END_S) return "S0";
  if (dwellS < WORLD_LIFE_TUNABLES.SIGNATURE_END_S) return "S1";
  if (dwellS < WORLD_LIFE_TUNABLES.SIDE_END_S) return "S2";
  if (dwellS < WORLD_LIFE_TUNABLES.MICROTRIP_END_S) return "S3";
  if (dwellS < WORLD_LIFE_TUNABLES.BREAK_END_S) return "S4";
  return "S5";
}

// --------------------------------------------------------------------
// Stage ordering (for bump-back logic)
// --------------------------------------------------------------------

const STAGE_ORDER: DwellStage[] = ["S0", "S1", "S2", "S3", "S4", "S5"];

/** Return the stage one step below `s`, clamped at S0. */
function priorStage(s: DwellStage): DwellStage {
  const idx = STAGE_ORDER.indexOf(s);
  return STAGE_ORDER[Math.max(0, idx - 1)];
}

/** Return the boundary time (seconds) where `stage` begins. */
function stageBoundaryS(stage: DwellStage): number {
  switch (stage) {
    case "S0":
      return 0;
    case "S1":
      return WORLD_LIFE_TUNABLES.SETTLE_END_S;
    case "S2":
      return WORLD_LIFE_TUNABLES.SIGNATURE_END_S;
    case "S3":
      return WORLD_LIFE_TUNABLES.SIDE_END_S;
    case "S4":
      return WORLD_LIFE_TUNABLES.MICROTRIP_END_S;
    case "S5":
      return WORLD_LIFE_TUNABLES.BREAK_END_S;
  }
}

// --------------------------------------------------------------------
// Helper: simple seeded jitter from NPC id
// --------------------------------------------------------------------

/** Deterministic hash → [0,1) from a string. Used for per-NPC jitter
 *  so NPCs don't synchronize. Not cryptographic. */
function npcHash01(npcId: string, salt: number): number {
  let h = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < npcId.length; i++) {
    h ^= npcId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= salt;
  h = Math.imul(h, 0x01000193);
  // Fold to [0,1)
  return ((h >>> 0) % 10000) / 10000;
}

// --------------------------------------------------------------------
// DwellTracker
// --------------------------------------------------------------------

function makeNpcDwell(nowMs: number): NpcDwell {
  return {
    dwellStartMs: nowMs,
    stage: "S0",
    lastSideActionMs: 0,
    lastMicroTripMs: 0,
    lastBreakMs: 0,
    frozen: false,
    frozenElapsedMs: 0,
    lastS5Sub: null,
  };
}

/** Per-NPC dwell tracker. Tracks the current stage, last side-action
 *  time, and resets. */
export class DwellTracker {
  private trackers = new Map<string, NpcDwell>();

  /** Get or create tracker for NPC. Updates the cached stage based on
   *  current elapsed time. */
  ensure(npcId: string, nowMs: number): NpcDwell {
    let d = this.trackers.get(npcId);
    if (!d) {
      d = makeNpcDwell(nowMs);
      this.trackers.set(npcId, d);
    }
    // Recompute cached stage from elapsed dwell.
    const elapsedS = this.elapsedS(d, nowMs);
    d.stage = dwellStage(elapsedS);
    return d;
  }

  /** Drop tracker (NPC despawned). */
  forget(npcId: string): void {
    this.trackers.delete(npcId);
  }

  /** Reset dwell on tool event. Per spec §4 reset rules:
   *  - Same-room repeat tool event: bump back one stage (S2→S1, S3→S2)
   *  - New-room tool event: full reset to S0
   *  Returns nothing; mutates the tracker in place. */
  onToolEvent(npcId: string, sameRoom: boolean, nowMs: number): void {
    const d = this.ensure(npcId, nowMs);

    if (!sameRoom) {
      // Full reset — NPC changed rooms.
      d.dwellStartMs = nowMs;
      d.stage = "S0";
      d.lastSideActionMs = 0;
      d.lastMicroTripMs = 0;
      d.lastBreakMs = 0;
      d.lastS5Sub = null;
      d.frozen = false;
      d.frozenElapsedMs = 0;
      return;
    }

    // Same-room: bump back one stage. Clamp dwellStartMs so
    // `dwellStage(elapsed)` returns the prior stage.
    const current = d.stage;
    const target = priorStage(current);
    if (target === current) {
      // Already at S0 — just refresh the start time to "now" so
      // S0 window restarts.
      d.dwellStartMs = nowMs;
    } else {
      // Set dwellStartMs so elapsed equals the midpoint of the target
      // stage window. This ensures dwellStage returns `target` and the
      // NPC gets meaningful time in that stage before re-advancing.
      const targetStart = stageBoundaryS(target);
      const targetEnd = stageBoundaryS(current); // current's boundary = end of target
      const midS = (targetStart + targetEnd) / 2;
      d.dwellStartMs = nowMs - midS * 1000;
    }
    d.stage = target;
    // Unfreeze if frozen (tool event always preempts).
    d.frozen = false;
    d.frozenElapsedMs = 0;
  }

  /** Freeze the ladder (user dialog open). */
  freeze(npcId: string, nowMs: number): void {
    const d = this.ensure(npcId, nowMs);
    if (d.frozen) return; // Already frozen.
    d.frozen = true;
    d.frozenElapsedMs = this.elapsedMs(d, nowMs);
  }

  /** Resume after dialog close. */
  resume(npcId: string, nowMs: number): void {
    const d = this.ensure(npcId, nowMs);
    if (!d.frozen) return; // Not frozen — noop.
    // Adjust dwellStartMs so elapsed time equals frozenElapsedMs.
    d.dwellStartMs = nowMs - d.frozenElapsedMs;
    d.frozen = false;
    d.frozenElapsedMs = 0;
  }

  /** Destroy all. */
  destroy(): void {
    this.trackers.clear();
  }

  // ------------------------------------------------------------------
  // Anti-pattern guards (spec §4)
  // ------------------------------------------------------------------

  /** Anti-pattern: Ping-pong A→B→A. Requires at least one in-room
   *  side-action between micro-trips. Returns true if a micro-trip
   *  is allowed. */
  canMicroTrip(npcId: string, nowMs: number): boolean {
    const d = this.trackers.get(npcId);
    if (!d) return false;
    // Require at least one side-action after the last micro-trip.
    if (d.lastMicroTripMs > 0 && d.lastSideActionMs < d.lastMicroTripMs) {
      return false;
    }
    return true;
  }

  /** Anti-pattern: Break-abandon. Never start S4 if a tool event
   *  landed within last 10s. The caller should pass the timestamp
   *  of the last tool event for this NPC. */
  canBreak(npcId: string, lastToolEventMs: number, nowMs: number): boolean {
    const BREAK_ABANDON_WINDOW_MS = 10_000;
    if (nowMs - lastToolEventMs < BREAK_ABANDON_WINDOW_MS) {
      return false;
    }
    // Also check break cooldown.
    const d = this.trackers.get(npcId);
    if (!d) return false;
    if (
      d.lastBreakMs > 0 &&
      nowMs - d.lastBreakMs < WORLD_LIFE_TUNABLES.BREAK_COOLDOWN_S * 1000
    ) {
      return false;
    }
    return true;
  }

  /** Anti-pattern: Lounge magnet. Check whether the lounge is at
   *  capacity. The caller passes current lounge occupant count.
   *  Cap at 3. */
  canOccupyLounge(currentOccupants: number): boolean {
    return currentOccupants < 3;
  }

  /** Anti-pattern: Synchronized choreography. Return per-NPC jitter
   *  multiplier in [1 - JITTER, 1 + JITTER]. The `salt` differentiates
   *  between different uses (e.g. side-action timing vs micro-trip
   *  timing). */
  jitter(npcId: string, salt: number): number {
    const base = npcHash01(npcId, salt);
    const j = WORLD_LIFE_TUNABLES.JITTER;
    return 1 - j + base * 2 * j;
  }

  /** Record that this NPC did a side-action. */
  recordSideAction(npcId: string, nowMs: number): void {
    const d = this.trackers.get(npcId);
    if (d) d.lastSideActionMs = nowMs;
  }

  /** Record that this NPC did a micro-trip. */
  recordMicroTrip(npcId: string, nowMs: number): void {
    const d = this.trackers.get(npcId);
    if (d) d.lastMicroTripMs = nowMs;
  }

  /** Record that this NPC did a break. */
  recordBreak(npcId: string, nowMs: number): void {
    const d = this.trackers.get(npcId);
    if (d) d.lastBreakMs = nowMs;
  }

  /** For S5: record the last completed substage so alternation works. */
  recordS5Sub(npcId: string, sub: "trip" | "break"): void {
    const d = this.trackers.get(npcId);
    if (d) d.lastS5Sub = sub;
  }

  /** For S5: get the next expected substage (alternation). */
  nextS5Sub(npcId: string): "trip" | "break" {
    const d = this.trackers.get(npcId);
    if (!d || d.lastS5Sub === null || d.lastS5Sub === "break") return "trip";
    return "break";
  }

  /** For S5: determine if this is a wander loop (15% chance, seeded). */
  isWanderLoop(npcId: string, nowMs: number): boolean {
    // Use nowMs as salt to get different results each evaluation.
    const roll = npcHash01(npcId, Math.floor(nowMs / 1000));
    return roll < 0.15;
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /** Elapsed milliseconds for a tracker, accounting for freeze. */
  private elapsedMs(d: NpcDwell, nowMs: number): number {
    if (d.frozen) return d.frozenElapsedMs;
    return nowMs - d.dwellStartMs;
  }

  /** Elapsed seconds for a tracker, accounting for freeze. */
  private elapsedS(d: NpcDwell, nowMs: number): number {
    return this.elapsedMs(d, nowMs) / 1000;
  }
}
