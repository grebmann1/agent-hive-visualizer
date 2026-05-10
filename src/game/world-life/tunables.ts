// World-life tunables — paste-ready from docs/world-life-spec.md §2.
//
// Stage 1 (this file) only needs `TOOL_QUIET_S` and `TICK_HZ` to drive
// the ACTIVE_TOOL → ROOM_IDLE transition + the 2 Hz evaluator. The
// other knobs are exported now so later stages (signature anims,
// dwell ladder, micro-trips, chit-chat) can `import` them without a
// second round of edits.
//
// IMPORTANT: do not change values here without updating §2 of the
// spec. The spec is the source of truth; this file is its mirror.
export const WORLD_LIFE_TUNABLES = {
  TOOL_QUIET_S: 8,           // grace before idle begins after a tool event
  LOUNGE_IDLE_S: 60,         // existing knob — preserve

  // Dwell ladder
  SETTLE_END_S: 8,
  SIGNATURE_END_S: 35,
  SIDE_END_S: 75,
  MICROTRIP_END_S: 150,
  BREAK_END_S: 240,

  // Signature
  SIG_MIN_S: 12,
  SIG_PROB: 0.35,            // per 5s tick
  SIG_COOLDOWN_S: 45,        // per-NPC, per-room

  // Micro-trip
  MICRO_MIN_S: 20,
  MICRO_PROB: 0.20,          // per 10s tick (raise to 0.60 in S3 dwell window)
  MICRO_COOLDOWN_S: 90,
  MICRO_DURATION_S: [10, 18],
  BREAK_DURATION_S: [25, 40],
  BREAK_COOLDOWN_S: 90,

  // Idle micro-anims
  IDLE_TICK_S: [4, 7],       // jittered
  IDLE_NOOP_PROB: 0.35,
  IDLE_MIN_GAP_S: 2.5,       // between two micro-actions same NPC
  IDLE_PROP_GAP_S: 20,       // max one prop micro per 20s

  // Chit-chat
  CHAT_PROB: 0.4,            // each NPC rolls; both must pass
  CHAT_DUR_S: [4, 10],
  CHAT_COOLDOWN_PAIR_S: 60,
  CHAT_COOLDOWN_AGENT_S: 12,
  CHAT_GLOBAL_MAX: 2,        // simultaneous chats on screen

  // Tick
  TICK_HZ: 2,                // state-machine evaluator
  JITTER: 0.2,               // ±20% on every interval
} as const;

export type WorldLifeTunables = typeof WORLD_LIFE_TUNABLES;
