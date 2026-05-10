# World Life Spec — Room Interactions, Dwell Cycling, Idle Anims, Chit-Chat

Synthesized from an 8-person brainstorm: 4 game/visual designers, 4 PM/UX
designers. All numeric defaults below are paste-ready for a `TUNABLES`
config block; every rule has a stated rationale so we can justify (and
later tune) it.

> **Guiding principle (PM #1):** the always-on tool pill above an agent
> is **sacred**. Tiers 3–5 of this spec exist to make the world feel
> alive *without ever interfering with the 2-second glance test* —
> "what is this agent doing right now?" must always be answerable from
> the pill alone.

---

## 1. Information Hierarchy (the contract)

| Tier | Signal | Lives | Tone |
|---|---|---|---|
| 1 | **Agent state** (current tool / state / error) | Emoji pill above sprite + roster row | Always-on, static between transitions |
| 2 | **State changes** (tool start/end, error, perm prompt) | Pill swap + sprite halo flash | Brief, ~600 ms, then settles back to Tier 1 |
| 3 | **Room ambient** (DevOps blinkenlights, library shelf glow) | The room itself | Slow loop, reinforces Tier 1, never contradicts it |
| 4 | **Idle micro-actions** (stretch, sip, yawn) | Agent body, never above head | Low frequency, suspends instantly on tool event |
| 5 | **NPC chit-chat** (emoji bubbles between idle agents) | Side of sprite, rounded bubble | Decorative, ephemeral, yields to all higher tiers |

### Hard rules (don't violate)

- The **square** pill = agent state. The **rounded** bubble = NPC flavor. Different shapes → user learns the difference once.
- Chit-chat draws from a **disjoint emoji set** from tool/state pills.
- A new **Tier-2 event despawns** any Tier-5 bubble within 2 tiles within one frame.
- **Banned chit-chat emoji** (reserved for real signals): 🚨 ⚠️ ❌ ⛔ 🔴 ❗ ‼️ 🆘 🔔 ✅ 🟢 ⏳ ⌛ 🔥. Lint at build time.
- Errors **out-rank everything** including neighbor Tier-2 events; add a screen-edge indicator too.
- **Noise budget per frame:** ≤ 1 Tier-2 flash + ≤ 2 Tier-3 ambient loops + 1 Tier-4 anim per idle agent + 1 Tier-5 bubble. ~5 moving things on screen, hard cap.

---

## 2. State Machine

Canonical states (one per NPC at all times):

| State | Meaning |
|---|---|
| `ACTIVE_TOOL` | Tool event in last `TOOL_QUIET_S` seconds. NPC at workstation. |
| `ROOM_SIGNATURE` | Performing the room's signature action (see §3). |
| `ROOM_IDLE` | At post, no tool activity, no signature. Default chill. |
| `MICRO_TRIP` | Short detour to adjacent room — water cooler, peek at coworker. Returns to origin seat. |
| `CHIT_CHAT` | Co-located with another idle NPC, exchanging emoji bubbles. |
| `IN_DIALOG` | User opened a dialog. Frozen, attentive pose. |
| `SUMMONED` | User issued a move/follow command. Overrides all except `IN_DIALOG`. |
| `TRAVELING` | Pathing wrapper; transient. |

### Transition table (key entries)

| From | To | Trigger | Timer / probability |
|---|---|---|---|
| _any_ | `ACTIVE_TOOL` | tool event received | immediate, preempts |
| _any non-user_ | `IN_DIALOG` | user opens dialog | immediate, preempts |
| _any non-user_ | `SUMMONED` | user move command | immediate, preempts |
| `ACTIVE_TOOL` | `ROOM_IDLE` | no tool event for `TOOL_QUIET_S` | 8 s |
| `ROOM_IDLE` | `ROOM_SIGNATURE` | dwell ≥ `SIG_MIN_S` & roll < `SIG_PROB` | check every 5 s |
| `ROOM_SIGNATURE` | `ROOM_IDLE` | signature anim complete | ~6–12 s |
| `ROOM_IDLE` | `MICRO_TRIP` | dwell ≥ `MICRO_MIN_S` & roll < `MICRO_PROB` | check every 10 s |
| `MICRO_TRIP` | `ROOM_IDLE` | path complete | ~15–25 s round-trip |
| `ROOM_IDLE` | `CHIT_CHAT` | NPC adjacent ≥ 3 s & both rolls < `CHAT_PROB` | check on proximity |
| `CHIT_CHAT` | `ROOM_IDLE` | duration ≥ `CHAT_DUR_S` or interrupt | 4–10 s |
| `ROOM_IDLE` | `TRAVELING→lounge` | dwell ≥ `LOUNGE_IDLE_S` | 60 s (existing knob) |
| `IN_DIALOG` | `ROOM_IDLE` | user closes dialog | immediate |
| `SUMMONED` | `ROOM_IDLE` | arrived at target | on arrival |

**Reset / preempt rules**

1. `tool_event` → force `ACTIVE_TOOL`, cancel current path/anim.
2. `user_dialog_open` → force `IN_DIALOG`, freeze in place; restore prior state on close *only if no tool_event meanwhile*.
3. `user_summon` → force `SUMMONED` unless `IN_DIALOG`.
4. Cooldowns are **per-NPC, per-state**, persisted across transitions.
5. Only one of `ROOM_SIGNATURE` / `MICRO_TRIP` / `CHIT_CHAT` active; rolls evaluated in that priority order each tick.

### Tunables (paste-ready)

```ts
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
```

Defaults target ~1 signature action / minute / room and ~1 micro-trip / 2 minutes / NPC at steady state.

---

## 3. Per-Room Signature Actions

Every room needs a **distinct silhouette at 16×16** (posture, prop, or background motion) — otherwise theming is wasted.

| Room | Signature action | Prop | Background motion |
|---|---|---|---|
| **desk / Ops Center** | Sit at terminal, 3-frame typing loop, occasional mouse-jiggle | none | terminal cursor blink |
| **coding_room / DevOps** | Stand at standing-desk, 4-frame hammer-on-keys, screen flickers green every 2 s | none | green screen flicker |
| **library / Training** | Walk to shelf → pull book → walk to nook → sit → page-flip 3 s → walk back → slot book (~8 s arc) | book sprite (held) | shelf glow |
| **tool_workshop / War Room** | Approach workbench, 2-frame sparks-fly + wrench-swing, occasional smoke puff | wrench (held while at bench) | sparks |
| **testing_lab / Security** | Stand at microscope/console, magnifying-glass-tilt loop, beaker bubbles in bg, red blip on failures | magnifier | beaker bubbles |
| **meeting_room** | Sit around table; if multiple agents present, auto-orient inward and emit alternating speech blips | none | wall clock tick |
| **lounge / Coffee Bar** | Walk to espresso → 2 s pour → carry mug back → sip-loop. Mug persists 10 s after leaving. | ☕ mug (held) | steam drift |

### Anti-patterns (forbid)

- **Teleport-to-anim**: snapping to the station instead of pathfinding reads as a bug. Always walk.
- **Anim-without-prop**: don't swing a wrench in empty air. If the workbench isn't in the room, don't play the swing.
- **Infinite loop with no exit beat**: cap loops at ~6 s, then idle-fidget at the station.
- **Identical anim across rooms**: distinct silhouettes only.
- **Hidden completion**: punctuate every event-end with a 4-frame sparkle/poof so the user knows when an agent finished.

---

## 4. Dwell Ladder (single-room time `t`, no new tool events)

| Stage | Window | Behavior |
|---|---|---|
| **S0 Settle** | 0–8 s | Walk to workstation, sit/stand idle |
| **S1 Signature** | 8–35 s | Room's primary loop + small fidgets every 4–7 s |
| **S2 Side-action** | 35–75 s | In-room secondary: stretch, sip mug, page-flip, glance at whiteboard. 1 action / 12–18 s |
| **S3 Micro-trip** | 75–150 s | 60% chance: brief out-and-back to adjacent room. 40%: in-room "deep focus" zoom anim |
| **S4 Break** | 150–240 s | Coffee break to lounge OR window-gaze. Returns to *same* workstation |
| **S5 Restless** | 240 s+ | Repeat S3/S4 alternating, 15% chance of "wander loop" (2 rooms then home). Bubble: "still working…" |

**Micro-trip rules**

1. Workstation reservation: NPC's seat stays "owned" for `MICRO_DURATION_S + 10 s`.
2. Adjacency only: micro-trips go to a room within graph-distance 1.
3. Carry-prop: NPC carries an item (mug, notebook) so the return reads as "same task continuing."
4. Hard interrupt: a new tool event mid-trip pivots immediately; prop teleports back.
5. No stacking: cannot start a new micro-trip while cooldown is active.
6. Pose preservation: on return, resume the *exact* signature anim frame they left.

**Reset conditions** (timer → 0)

- New tool event of a different room category
- Tool error / non-zero exit (jump to S1 with "alert" overlay)
- User dialog opens (freeze ladder, resume on close)
- `/summon` or explicit room override
- Same-room repeat tool event: bump back one stage (S2→S1, S3→S2), don't reset

**Anti-patterns**

- Ping-pong A→B→A: `MICRO_COOLDOWN_S` + require ≥ 1 in-room action between trips.
- Pose jitter: anim choices sticky for their interval.
- Break-abandon: never start S4 if a tool event landed within last 10 s.
- Synchronized choreography: all rolls use per-NPC seeded jitter.
- Lounge magnet: cap simultaneous lounge occupants at 3; extras go to library or window-gaze.
- Stage-skipping: never jump S1→S4. Ladder is monotonic unless a reset fires.

---

## 5. Idle Micro-Animations

12 catalog actions, verb-first, prop-second, emoji-last:

| # | Name | Duration | Prop / Emoji | Where |
|---|---|---|---|---|
| 1 | stretch-arms | 1.2 s, plays once | none | any standing |
| 2 | yawn | 0.8 s | tiny `z` | any |
| 3 | shift-weight | 0.6 s (foot tap / lean) | none | any standing |
| 4 | scratch-head | 0.7 s | none | any |
| 5 | sip-mug | 2.0 s loop | ☕ | lounge, desk, library |
| 6 | check-watch | 0.6 s | ⏱ | any (esp. seated) |
| 7 | glance-around | 0.9 s (head L→R) | none | any |
| 8 | doze-nod | 1.4 s | `z` particle | seated only |
| 9 | phone-buzz | 1.0 s | 📱 + `!` | any |
| 10 | page-flip | 0.8 s | 📄 | desk / reading seat |
| 11 | pet-cat / feed-bird | 1.5 s | 🐈 / 🐦 passes by | lounge, garden |
| 12 | hum-notes | 1.0 s loop | ♪ | any (rare) |

Bonus drifters (not per-NPC): paper airplane, dust mote, pet wandering — read as "alive" without animating any sprite.

**Frequency on each idle tick (every 4–7 s, jittered):**

- 35 % no-op (stillness is part of life)
- 25 % cheap micro-fidget (1–4)
- 15 % signature-action beat (owned by §3)
- 10 % prop micro (5, 10) — only if prop already in scene
- 8 % glance / watch (6, 7)
- 5 % doze-nod (seated only, gated by `z`-cap)
- 2 % rare flavor (9, 11, 12)

**Layering rules**

1. Single animation channel per sprite. Micro-actions pre-empt the signature loop, never overlap. Queue, don't mix.
2. Minimum 2.5 s gap between two micro-actions on the same NPC.
3. Phase-offset by NPC id (`tick + hash(id) % 1000ms`) so a room of 6 doesn't yawn in unison — *unless* you want a contagious yawn (1 % chance to copy a neighbor within 2 tiles within 1.5 s).
4. Particles (`z`, ♪, `!`) live on a separate layer above the sprite — fade independently, never desync the sprite frame.
5. Stillness budget: ≥ 30 % of NPCs in a room should be doing nothing at any moment.

**Pause rule (one line):** Suspend the idle ticker whenever the NPC is in `dialog`, `walking`, `tool-action`, `transition`, or `selected-by-user`. Resume after a 0.5 s settle delay.

---

## 6. Chit-Chat (NPC-to-NPC)

### Triggers (ALL must hold for ≥ 1.5 s)

1. Co-room (same `roomId`)
2. Both `ROOM_IDLE` (no tool event in last 2 s)
3. Proximity ≤ 120 px (walk them together first if needed, ease-in 600 ms)
4. Pair cooldown clear (≥ 25 s since last chat for this pair)
5. Roll < `CHAT_PROB` per 2 s tick

**Priority rooms:** lounge (60 % roll), desk (30 %), kitchen (45 %). **Server-room never triggers** (work zone).

### Pairing

- 2 agents only for v1. A 3rd entering mid-chat gets a solo "👀" and waits.
- Duration: 3–5 exchanges (~ 8–14 s).
- Per-agent cooldown: 12 s. Per-pair cooldown: 60 s.
- Global cap: 2 simultaneous chats on screen.

### Visual

- Rounded speech bubble, 28 px tall, anchored to the **side** of the agent sprite (left/right based on relative position). **Never above the head** — that real estate is the tool pill.
- 1–2 emoji max per bubble. Combos allowed (`✨💡`, `🎉🍻`) only from the table below.
- Per-bubble timing: 350 ms fade-in → 1800 ms hold → 250 ms fade-out.
- 400 ms gap between speakers. Initiator first.
- 4 px tail bob on appear (Sims plumbob feel).

### Emoji Exchange Library (16)

| # | Vibe | Initiator | Reply |
|---|---|---|---|
| 1 | greeting | 👋 | 🙂 |
| 2 | agreement | 👍 | 😊 |
| 3 | share win | 🎉 | 🍻 |
| 4 | gossip | 🤫 | 👀 |
| 5 | rivalry | 😏 | 😤 |
| 6 | commiserate | 😩 | 🫂 |
| 7 | brainwave | ✨💡 | 🤯 |
| 8 | flex | 💪 | 🙄 |
| 9 | confused | 🤔 | 🤷 |
| 10 | bug talk | 🐛 | 💀 |
| 11 | coffee chat | ☕ | ☕ |
| 12 | encouragement | 🫶 | 🥹 |
| 13 | snark | 😒 | 😆 |
| 14 | hype | 🔥 | 🚀 |
| 15 | sleepy | 🥱 | 😴 |
| 16 | farewell | ✌️ | 👋 |

Selection: weighted random. Greeting (#1) always opens; farewell (#16) always closes if duration > 3 exchanges.

### Mood biasing

- Agent who just had a tool **error** weights toward 6, 9, 10.
- Agent who just had a **success** weights toward 3, 7, 14.
- Two positive vibes in a row → bonus 🎊 burst from both simultaneously.
- Two rivalry/snark → forced farewell next turn, +5 s extra cooldown.

### Tool-event suspension

When either agent receives a real tool event mid-chat:
1. Current bubble finishes its fade-out (don't yank).
2. Chat state → `INTERRUPTED`. Partner shows one "👋" (polite exit).
3. Tool pill takes over.
4. Pair cooldown applied. **Do not resume** — chats are ephemeral.

### Anti-patterns

- No bubble while tool pill is rendering.
- No same-emoji ping-pong > 2 turns (cap repeats).
- No stacking bubbles vertically; one active per agent.
- No chat triggers during room transitions.
- Hard kill any chat exceeding 16 s wall-clock.
- Two pairs cannot occupy overlapping pixel space; nudge the second pair 40 px apart before starting.

---

## 7. Accessibility

### Motion

- Per-agent cap: 1 ambient anim per 8–12 s (jittered, never synchronized).
- Per-agent bubble cap: 1 chit-chat bubble per 20 s; bubble dwell 3.5 s.
- Screen-wide cap: ≤ 3 simultaneously animating sprites + ≤ 2 visible bubbles.
- No anim loop faster than 3 Hz; no high-contrast flicker (WCAG 2.3.1).
- **`prefers-reduced-motion`:** disable idle anims (sprites freeze on neutral frame), replace bubble fades with instant show/hide, keep state-critical anims (typing → static dot).

### Bubble readability

- Background: cream `#F4ECD8` at 92 % alpha + 1 px dark outline `#2B2B33` (contrast ≥ 4.5:1).
- 2 px outer + 1 px inner stroke survives both grass and floor tiles.
- Static tail (no wiggle).
- Emoji rendered at 20–24 px min, never below 16 px. Pre-render bitmap at integer scales to avoid blurry subpixel AA.
- **Color-blind safe set** (deuteranopia / protanopia / tritanopia): 💭 🤔 ☕ 📎 💡 🎧 📚 🪴 🍵 🐈 🌧️ 🛠️. Avoid red/green pairings.

### Audio

- Default OFF.
- If shipped: single soft "blip" (~ 80 ms, –24 LUFS, low-pass 2 kHz). Never per-keystroke.
- Per-agent mute + global mute in calm mode. Respect OS Do-Not-Disturb.
- Debounce: never play SFX for two bubbles within 1.5 s.

### Calm Mode toggle

- **Removes:** ambient idle anims, chit-chat bubbles, decorative parallax, all SFX, particle FX.
- **Keeps:** agent presence, status icons, task progress, error states, user-initiated dialogs. The room becomes a still diorama that only updates on real events.

### Screen-reader

- Mirror semantically meaningful state into a visually-hidden DOM region: roster with `aria-live="polite"`; task/error events `aria-live="assertive"`.
- Chit-chat bubbles `aria-hidden` by default. Expose via on-demand "Who's around?" panel.
- Focus order follows visual reading order. All toggles (calm mode, mute, reduced-motion) keyboard-operable with visible focus rings.
- Color is never the sole status channel — pair with shape or text label.

---

## 8. Storyboards (acceptance tests)

### Solo (1 agent, 3 min)

Spawn → walk to desk → typing while files edit (tiny file icons pop above head per write) → jog to Test Bench on Bash test (beaker bubbles green) → return to desk, idle stretch → exit puff.
**Acceptance:** glance-once tells the user which file changed and whether tests passed, without reading transcript.

### Crowd (5 agents, 1 active)

Four idlers at coffee / couches; chit-chat between two. Active agent stays focused; chit-chat **never** triggers on the active one even if proximity matches.
**Acceptance:** at-a-glance you can ID the working agent in < 1 s; chit-chat never overlaps a status pill spatially.

### Sub-agent burst (Task tool, 30 s)

Parent emits "summon" particle → ephemeral sub-agent **fades in adjacent** (NOT from a door — signals impermanence) → smaller sprite + dashed name tag → on despawn: scroll-handoff, dust poof.
**Acceptance:** sub-agents are never confused for peer agents in the roster.

### Error (Bash failure × 3)

Red screen flash → chit-chat suppressed for this agent + within 2 tiles → retry pip dots (• • •) above head → persistent ❗ marker after 3rd fail (a UI affordance, not a bubble) → click marker jumps transcript to error.
**Acceptance:** a user landing during retry #2 sees the problem in < 2 s and knows it's real, not flavor.

### User summons

Click roster → highlight ring → active chit-chat fades (not popped) → partner waves and resumes idle pathing → summoned agent pathfinds to Ops Center → chat input focuses.
**Acceptance:** summon never drops a tool-in-flight; abandoned partner never T-poses.

### Long idle (5 min → return)

After 60 s: lean back. After 180 s: `z` particle. After 300 s: dimmed sprite + screen-saver on monitor. On tab-visibility return: wake-stagger (50 ms offset per agent), stretch (400 ms), `z` fade, sprite re-saturates. Don't dim if a tool call is actually pending.
**Acceptance:** returning after lunch shows a believable "everyone wakes up" moment in < 1 s; no agent that was mid-task appears to have been sleeping.

---

## 9. Observability

Single structured log per state transition:

```
[npc.id] t=<ms> FROM→TO trigger=<name> roll=<x>/<threshold> dwell=<s> cooldowns={sig:12, micro:0, chat:45}
```

Ring-buffer last 50 transitions per NPC. Hold `~` to surface a debug overlay showing current state, dwell timer, next-roll-in, active cooldowns. Every roll (pass or fail) at `trace` level so we can answer "why didn't she go get coffee?" with one grep.

---

## 10. The 2-Second Glance Test (the bar)

After all features ship, a user glancing for 2 seconds **must** be able to:

1. Count agents,
2. Name each agent's current tool/state from the pill alone, and
3. Spot any error or awaiting-input state without reading text.

If, in user testing, flavor (NPC bubbles, idle anims, room glows) ever causes a misread of state, that flavor element is **over-budget** and gets dimmed, slowed, or cut. The pill, and only the pill, owns the answer to "what is this agent doing right now?"

---

## 11. Implementation Order (suggested)

1. **State machine + tunables** (§2). Wire transitions, log everything, ship behind a flag.
2. **Per-room signature actions** (§3). Pick one room (lounge) end-to-end first to validate the choreo pipeline.
3. **Idle micro-anims** (§5). Cheap, high-impact, low-risk.
4. **Dwell ladder** (§4). Builds on signatures + idle.
5. **Chit-chat** (§6). Last because it depends on (a) reliable idle detection and (b) the noise-budget contract (§1) being respected.
6. **Calm mode + a11y** (§7). Ship simultaneously with chit-chat; it's the off-switch for everything 5 added.

Each stage: build, smoke-test against the 2-second glance test (§10), tune, then move on.

---

## 12. Open Questions (revisit before implementing)

- **Sub-agents and chit-chat:** can a parent and its own sub-agent chat? Probably no — feels like talking to yourself. Confirm.
- **External agents (Cursor, master Claude):** different chat emoji set, or shared? Lean toward shared so it doesn't feel cliquey.
- **Audio:** ship muted-by-default with a one-click toggle, or no audio in v1?
- **Held props:** are we OK adding a 1-tile sprite layer above the body for mug / book / wrench, or do we want emoji-as-prop?
- **`coding_room` / DevOps:** today no behavior routes there (per the registry audit). Decide: route Edit/Write there, or retire the room from the rotation?
