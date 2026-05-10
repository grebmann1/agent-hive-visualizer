// World-life state machine (spec §2).
//
// Pure-function transition logic + per-NPC cooldowns + a ring-buffered
// transition log. Stage 1: no Phaser, no Zustand, no DOM. The evaluator
// in WorldScene calls `nextState(prev, trigger, ctx)` and feeds the
// result through `recordTransition(...)` to keep the ring buffer
// updated. Visuals come in later tickets (#241, #238, #237, #240, #239).
//
// The function is intentionally narrow: it returns the NEW state given
// the OLD state plus a labelled trigger. Cooldowns / probability rolls
// are computed by the caller (the evaluator) and passed in via `ctx` so
// this module stays trivially testable.

import { WORLD_LIFE_TUNABLES } from "./tunables";

// --------------------------------------------------------------------
// State + trigger types
// --------------------------------------------------------------------

export type WorldLifeState =
  | "ACTIVE_TOOL"
  | "ROOM_SIGNATURE"
  | "ROOM_IDLE"
  | "MICRO_TRIP"
  | "CHIT_CHAT"
  | "IN_DIALOG"
  | "SUMMONED"
  | "TRAVELING";

/** Stable trigger names — appear verbatim in the structured log so a
 *  grep can answer "why didn't she go get coffee?" (spec §9). The
 *  full `WorldLifeTrigger` discriminated union below carries any
 *  per-trigger payload (roll, threshold, dwellS). */
export type WorldLifeTriggerName =
  // Preempting external events
  | "tool_event"
  | "user_dialog_open"
  | "user_dialog_close"
  | "user_summon"
  | "summon_arrived"
  // Per-state timeouts / rolls evaluated by the 2 Hz tick
  | "tool_quiet_elapsed"
  | "signature_roll"
  | "signature_complete"
  | "microtrip_roll"
  | "microtrip_complete"
  | "chitchat_roll"
  | "chitchat_complete"
  | "lounge_idle_elapsed"
  // Catch-all for "tick fired, nothing matched" — recorded at trace
  // level only so we can see the cadence without changing state.
  | "tick";

/** Discriminated union of triggers. Variants that need roll/threshold
 *  or a dwell measurement carry them in the trigger itself, so the
 *  type system rejects callers who forget the data instead of the
 *  FSM silently treating absent values as "didn't pass". */
export type WorldLifeTrigger =
  | { name: "tool_event" }
  | { name: "user_dialog_open" }
  | { name: "user_dialog_close" }
  | { name: "user_summon" }
  | { name: "summon_arrived" }
  | { name: "tool_quiet_elapsed"; dwellS: number }
  | { name: "signature_roll"; dwellS: number; roll: number; threshold: number }
  | { name: "signature_complete" }
  | { name: "microtrip_roll"; dwellS: number; roll: number; threshold: number }
  | { name: "microtrip_complete" }
  | {
      name: "chitchat_roll";
      roll: number;
      threshold: number;
      hasChatPartner: boolean;
    }
  | { name: "chitchat_complete" }
  | { name: "lounge_idle_elapsed"; dwellS: number }
  | { name: "tick" };

// --------------------------------------------------------------------
// Cooldown bookkeeping (per-NPC)
// --------------------------------------------------------------------

/** Per-NPC cooldown deadlines. All values are absolute timestamps in
 *  ms (the same clock the caller uses — `Date.now()` or `scene.time.now`).
 *  `0` (or absent) means "no cooldown active". The pair / agent maps
 *  are keyed by partner-id and agent-id respectively. */
export interface NpcCooldowns {
  /** Per-NPC, per-room signature cooldown — keyed by `roomId`. */
  sig: Record<string, number>;
  /** Last time this NPC took a micro-trip (single value, per NPC). */
  micro: number;
  /** Per-pair chit-chat cooldown — keyed by partner agent id. */
  chatPair: Record<string, number>;
  /** Per-agent chit-chat cooldown (after any chat ends). */
  chatAgent: number;
}

export function makeCooldowns(): NpcCooldowns {
  return {
    sig: {},
    micro: 0,
    chatPair: {},
    chatAgent: 0,
  };
}

/** True iff the NPC's signature cooldown for `roomId` has expired (or
 *  was never set). `now` is wall-clock ms. */
export function sigCooldown(
  cd: NpcCooldowns,
  roomId: string,
  now: number,
): { ready: boolean; remainingS: number } {
  const until = cd.sig[roomId] ?? 0;
  const remainingS = Math.max(0, (until - now) / 1000);
  return { ready: now >= until, remainingS };
}

export function setSigCooldown(
  cd: NpcCooldowns,
  roomId: string,
  now: number,
): void {
  cd.sig[roomId] = now + WORLD_LIFE_TUNABLES.SIG_COOLDOWN_S * 1000;
}

export function microCooldown(
  cd: NpcCooldowns,
  now: number,
): { ready: boolean; remainingS: number } {
  const until = cd.micro;
  const remainingS = Math.max(0, (until - now) / 1000);
  return { ready: now >= until, remainingS };
}

export function setMicroCooldown(cd: NpcCooldowns, now: number): void {
  cd.micro = now + WORLD_LIFE_TUNABLES.MICRO_COOLDOWN_S * 1000;
}

export function chatPairCooldown(
  cd: NpcCooldowns,
  partnerId: string,
  now: number,
): { ready: boolean; remainingS: number } {
  const until = cd.chatPair[partnerId] ?? 0;
  const remainingS = Math.max(0, (until - now) / 1000);
  return { ready: now >= until, remainingS };
}

export function setChatPairCooldown(
  cd: NpcCooldowns,
  partnerId: string,
  now: number,
): void {
  cd.chatPair[partnerId] =
    now + WORLD_LIFE_TUNABLES.CHAT_COOLDOWN_PAIR_S * 1000;
}

export function chatAgentCooldown(
  cd: NpcCooldowns,
  now: number,
): { ready: boolean; remainingS: number } {
  const until = cd.chatAgent;
  const remainingS = Math.max(0, (until - now) / 1000);
  return { ready: now >= until, remainingS };
}

export function setChatAgentCooldown(cd: NpcCooldowns, now: number): void {
  cd.chatAgent = now + WORLD_LIFE_TUNABLES.CHAT_COOLDOWN_AGENT_S * 1000;
}

// --------------------------------------------------------------------
// Transition table (pure)
// --------------------------------------------------------------------

/** Pure transition function. Returns the next state given the current
 *  state, a trigger, and a context object. Returns `prev` unchanged when
 *  no rule fires (the caller can skip the log line in that case).
 *
 *  The function does NOT consult the cooldown maps — the evaluator is
 *  expected to gate `*_roll` triggers behind cooldowns BEFORE calling
 *  this. Keeping the FSM ignorant of cooldowns means it stays
 *  byte-identical between Stage 1 and later stages where cooldown
 *  policy may shift.
 */
export function nextState(
  prev: WorldLifeState,
  trigger: WorldLifeTrigger,
): WorldLifeState {
  // 1. Hard preempts — these win regardless of `prev`. Spec §2 reset
  //    rules: tool_event > user_dialog_open > user_summon.
  switch (trigger.name) {
    case "tool_event":
      return "ACTIVE_TOOL";
    case "user_dialog_open":
      // Per spec: any non-user state preempts to IN_DIALOG. SUMMONED
      // also yields to IN_DIALOG (spec §2 rule 3 says SUMMONED yields
      // when IN_DIALOG; here the user is *opening* a dialog).
      return "IN_DIALOG";
    case "user_summon":
      // SUMMONED preempts everything except IN_DIALOG.
      if (prev === "IN_DIALOG") return prev;
      return "SUMMONED";
    case "user_dialog_close":
      if (prev === "IN_DIALOG") return "ROOM_IDLE";
      return prev;
    case "summon_arrived":
      if (prev === "SUMMONED") return "ROOM_IDLE";
      return prev;
    default:
      break;
  }

  // 2. Per-state timed transitions.
  switch (prev) {
    case "ACTIVE_TOOL":
      if (
        trigger.name === "tool_quiet_elapsed" &&
        trigger.dwellS >= WORLD_LIFE_TUNABLES.TOOL_QUIET_S
      ) {
        return "ROOM_IDLE";
      }
      return prev;

    case "ROOM_IDLE":
      // Priority order per spec §2 rule 5:
      //   ROOM_SIGNATURE → MICRO_TRIP → CHIT_CHAT
      if (
        trigger.name === "signature_roll" &&
        trigger.dwellS >= WORLD_LIFE_TUNABLES.SIG_MIN_S &&
        trigger.roll < trigger.threshold
      ) {
        return "ROOM_SIGNATURE";
      }
      if (
        trigger.name === "microtrip_roll" &&
        trigger.dwellS >= WORLD_LIFE_TUNABLES.MICRO_MIN_S &&
        trigger.roll < trigger.threshold
      ) {
        return "MICRO_TRIP";
      }
      if (
        trigger.name === "chitchat_roll" &&
        trigger.hasChatPartner &&
        trigger.roll < trigger.threshold
      ) {
        return "CHIT_CHAT";
      }
      if (
        trigger.name === "lounge_idle_elapsed" &&
        trigger.dwellS >= WORLD_LIFE_TUNABLES.LOUNGE_IDLE_S
      ) {
        return "TRAVELING";
      }
      return prev;

    case "ROOM_SIGNATURE":
      if (trigger.name === "signature_complete") return "ROOM_IDLE";
      return prev;

    case "MICRO_TRIP":
      if (trigger.name === "microtrip_complete") return "ROOM_IDLE";
      return prev;

    case "CHIT_CHAT":
      if (trigger.name === "chitchat_complete") return "ROOM_IDLE";
      return prev;

    case "TRAVELING":
      // Pathing wrapper; transient. Resolved when the path drains —
      // the evaluator emits `summon_arrived` (or equivalent) once the
      // target cell is reached. Stage 1 doesn't drive TRAVELING yet.
      return prev;

    case "IN_DIALOG":
      // Only `user_dialog_close` (handled above) leaves this state.
      return prev;

    case "SUMMONED":
      // Only `summon_arrived` (handled above) leaves this state.
      return prev;

    default: {
      // Exhaustiveness guard: if a future state is added to
      // WorldLifeState, this assignment fails to type-check until the
      // switch is updated.
      const _exhaustive: never = prev;
      return _exhaustive;
    }
  }
}

// --------------------------------------------------------------------
// Ring-buffered transition log (per NPC, last 50)
// --------------------------------------------------------------------

const RING_CAP = 50;

export interface TransitionLogEntry {
  /** Wall-clock ms timestamp (Date.now()). Distinct from the scene
   *  clock so log lines match server logs / event-bus timestamps. */
  ts: number;
  npcId: string;
  from: WorldLifeState;
  to: WorldLifeState;
  trigger: WorldLifeTriggerName;
  /** Time the NPC spent in `from` before the transition (seconds). */
  dwellS: number;
  /** Optional roll context — present for *_roll triggers. */
  roll?: number;
  threshold?: number;
  /** Snapshot of the NPC's cooldowns at the moment of the transition,
   *  in seconds remaining. Used in the structured log line. */
  cooldownsS: { sig: number; micro: number; chat: number };
}

/** All in-memory state behind `worldLifeDebug`. Single object so a
 *  debug overlay (or the dev-time `window.__worldLifeDebug`) can pull
 *  every NPC's view in one read. */
class WorldLifeDebug {
  /** Current state per NPC. */
  states: Record<string, WorldLifeState> = {};
  /** Ring buffer (last 50 transitions) per NPC. */
  transitions: Record<string, TransitionLogEntry[]> = {};
  /** When the NPC first entered its current state (ms). */
  enteredAt: Record<string, number> = {};
  /** Per-NPC cooldown maps. Exposed so a debug overlay can render
   *  remaining seconds. */
  cooldowns: Record<string, NpcCooldowns> = {};

  ensure(npcId: string, initial: WorldLifeState, now: number): void {
    if (this.states[npcId] === undefined) {
      this.states[npcId] = initial;
      this.enteredAt[npcId] = now;
      this.transitions[npcId] = [];
      this.cooldowns[npcId] = makeCooldowns();
    }
  }

  forget(npcId: string): void {
    delete this.states[npcId];
    delete this.enteredAt[npcId];
    delete this.transitions[npcId];
    delete this.cooldowns[npcId];
  }

  /** Record a state transition. Pushes to the ring buffer (capped at
   *  50) and updates `states[npcId]` + `enteredAt[npcId]`. The caller
   *  is responsible for emitting the human-readable log line. */
  record(entry: TransitionLogEntry): void {
    const buf = this.transitions[entry.npcId] ?? [];
    buf.push(entry);
    if (buf.length > RING_CAP) buf.splice(0, buf.length - RING_CAP);
    this.transitions[entry.npcId] = buf;
    this.states[entry.npcId] = entry.to;
    this.enteredAt[entry.npcId] = entry.ts;
  }

  recent(npcId: string): TransitionLogEntry[] {
    return this.transitions[npcId] ?? [];
  }
}

export const worldLifeDebug = new WorldLifeDebug();

// Dev-time hook so reviewers can inspect the ring buffer from the
// browser devtools without rebuilding. SSR/Node guard required —
// Next.js executes this module on the server during the prerender pass
// (the import graph reaches WorldScene from a client component, but
// the server still parses it). Gated behind a NODE_ENV check so the
// hook is stripped from production bundles.
if (
  process.env.NODE_ENV !== "production" &&
  typeof window !== "undefined"
) {
  (window as unknown as { __worldLifeDebug?: WorldLifeDebug }).__worldLifeDebug =
    worldLifeDebug;
}

/** Build the spec §9 log line for a transition. Pure — no side effects.
 *  Format:
 *    [npc.id] t=<ms> FROM→TO trigger=<name> roll=<x>/<threshold> dwell=<s> cooldowns={sig:12, micro:0, chat:45}
 *  Roll segment is omitted when the trigger had no roll. */
export function formatTransitionLog(entry: TransitionLogEntry): string {
  const rollPart =
    entry.roll !== undefined && entry.threshold !== undefined
      ? ` roll=${entry.roll.toFixed(2)}/${entry.threshold.toFixed(2)}`
      : "";
  const dwell = entry.dwellS.toFixed(1);
  const cd = entry.cooldownsS;
  return (
    `[${entry.npcId}] t=${entry.ts} ${entry.from}→${entry.to} ` +
    `trigger=${entry.trigger}${rollPart} dwell=${dwell}s ` +
    `cooldowns={sig:${Math.round(cd.sig)}, micro:${Math.round(cd.micro)}, chat:${Math.round(cd.chat)}}`
  );
}

/** Convenience: derive the seconds-remaining cooldown snapshot used in
 *  the log line. The "sig" slot collapses every per-room signature
 *  cooldown into the maximum remaining (good enough for the log). */
export function snapshotCooldownsS(
  cd: NpcCooldowns,
  now: number,
): { sig: number; micro: number; chat: number } {
  let sig = 0;
  for (const k of Object.keys(cd.sig)) {
    const remaining = Math.max(0, (cd.sig[k] - now) / 1000);
    if (remaining > sig) sig = remaining;
  }
  let chat = Math.max(0, (cd.chatAgent - now) / 1000);
  for (const k of Object.keys(cd.chatPair)) {
    const remaining = Math.max(0, (cd.chatPair[k] - now) / 1000);
    if (remaining > chat) chat = remaining;
  }
  const micro = Math.max(0, (cd.micro - now) / 1000);
  return { sig, micro, chat };
}
