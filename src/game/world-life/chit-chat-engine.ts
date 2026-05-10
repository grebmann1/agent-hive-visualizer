import { WORLD_LIFE_TUNABLES } from "./tunables";

// --- Emoji Exchange Library ---

export interface ExchangeVibe {
  id: number;
  name: string;
  initiator: string; // emoji(s)
  reply: string; // emoji(s)
  mood: "positive" | "negative" | "neutral";
}

export const EXCHANGE_LIBRARY: readonly ExchangeVibe[] = [
  { id: 1, name: "greeting", initiator: "👋", reply: "🙂", mood: "neutral" },
  { id: 2, name: "agreement", initiator: "👍", reply: "😊", mood: "positive" },
  { id: 3, name: "share-win", initiator: "🎉", reply: "🍻", mood: "positive" },
  { id: 4, name: "gossip", initiator: "🤫", reply: "👀", mood: "neutral" },
  { id: 5, name: "rivalry", initiator: "😏", reply: "😤", mood: "negative" },
  {
    id: 6,
    name: "commiserate",
    initiator: "😩",
    reply: "🫂",
    mood: "negative",
  },
  {
    id: 7,
    name: "brainwave",
    initiator: "✨💡",
    reply: "🤯",
    mood: "positive",
  },
  { id: 8, name: "flex", initiator: "💪", reply: "🙄", mood: "neutral" },
  { id: 9, name: "confused", initiator: "🤔", reply: "🤷", mood: "negative" },
  { id: 10, name: "bug-talk", initiator: "🐛", reply: "💀", mood: "negative" },
  {
    id: 11,
    name: "coffee-chat",
    initiator: "☕",
    reply: "☕",
    mood: "neutral",
  },
  {
    id: 12,
    name: "encouragement",
    initiator: "🫶",
    reply: "🥹",
    mood: "positive",
  },
  { id: 13, name: "snark", initiator: "😒", reply: "😆", mood: "negative" },
  { id: 14, name: "hype", initiator: "🔥", reply: "🚀", mood: "positive" },
  { id: 15, name: "sleepy", initiator: "🥱", reply: "😴", mood: "neutral" },
  { id: 16, name: "farewell", initiator: "✌️", reply: "👋", mood: "neutral" },
] as const;

// --- Mood biasing ---

export type AgentMood = "recent-error" | "recent-success" | "neutral";

// --- Chat session state ---

export interface ChatSession {
  /** Unique session id (for tracking). */
  sessionId: number;
  /** NPC who initiated. */
  initiatorId: string;
  /** NPC who is the partner. */
  partnerId: string;
  /** Start time (wall-clock ms). */
  startMs: number;
  /** Exchanges so far (vibeId list). */
  exchanges: number[];
  /** Whose turn to speak: "initiator" or "partner". */
  turn: "initiator" | "partner";
  /** True if the session ended (naturally or by interruption). */
  ended: boolean;
  /** If ended by interruption, which NPC got the tool event. */
  interruptedBy?: string;
  /** Total planned exchanges (3-5). */
  plannedExchanges: number;
  /** The mood of the initiator at session start (used for biasing). */
  initiatorMood: AgentMood;
  /** Whether a forced farewell is queued (rivalry/snark escalation). */
  forceFarewellNext: boolean;
  /** Extra cooldown penalty in ms (e.g. from rivalry escalation). */
  extraCooldownMs: number;
}

// --- Helpers ---

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function weightedPick(weights: Map<number, number>): number {
  const entries = Array.from(weights.entries());
  const totalWeight = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * totalWeight;
  for (const [id, w] of entries) {
    roll -= w;
    if (roll <= 0) return id;
  }
  // Fallback: return last entry
  return entries[entries.length - 1][0];
}

function getVibeById(id: number): ExchangeVibe | undefined {
  return EXCHANGE_LIBRARY.find((v) => v.id === id);
}

// IDs that are boosted for error mood
const ERROR_BOOST_IDS = [6, 9, 10];
// IDs that are boosted for success mood
const SUCCESS_BOOST_IDS = [3, 7, 14];
// IDs for rivalry/snark detection
const RIVALRY_SNARK_IDS = [5, 13];

// --- Room probability helper ---

export function chatProbForRoom(roomId: string): number {
  if (roomId === "lounge") return 0.6;
  if (roomId === "kitchen") return 0.45;
  if (roomId === "desk") return 0.3;
  if (roomId === "server_room" || roomId === "ops_center") return 0;
  return WORLD_LIFE_TUNABLES.CHAT_PROB; // 0.4 default
}

// --- Engine ---

export class ChitChatEngine {
  private sessions: ChatSession[] = [];
  private sessionCounter = 0;

  /** Per-pair cooldown: keyed by "idA|idB" (sorted). */
  private pairCooldowns = new Map<string, number>();
  /** Per-agent cooldown. */
  private agentCooldowns = new Map<string, number>();

  /**
   * Try to start a chat between two NPCs.
   * Returns the session if started, null if blocked.
   */
  tryStartChat(
    initiatorId: string,
    partnerId: string,
    initiatorMood: AgentMood,
    nowMs: number,
  ): ChatSession | null {
    // 1. Check canChat for both participants
    if (!this.canChat(initiatorId, nowMs)) return null;
    if (!this.canChat(partnerId, nowMs)) return null;

    // 2. Check global cap
    if (this.isAtGlobalCap()) return null;

    // 3. Check pair cooldown (60s)
    const pk = pairKey(initiatorId, partnerId);
    const pairCd = this.pairCooldowns.get(pk);
    if (pairCd !== undefined && nowMs < pairCd) return null;

    // 4. Create session with plannedExchanges = random(3, 5)
    const plannedExchanges = randomInt(3, 5);

    this.sessionCounter++;
    const session: ChatSession = {
      sessionId: this.sessionCounter,
      initiatorId,
      partnerId,
      startMs: nowMs,
      exchanges: [1], // 5. First exchange is ALWAYS greeting (#1)
      turn: "partner", // After initiator greets, partner replies
      ended: false,
      plannedExchanges,
      initiatorMood,
      forceFarewellNext: false,
      extraCooldownMs: 0,
    };

    this.sessions.push(session);

    // 6. Return the session
    return session;
  }

  /**
   * Advance a session: pick the next exchange vibe, mark whose turn.
   * Returns the emoji to show, or null if session ended/invalid.
   */
  advance(
    sessionId: number,
    nowMs: number,
  ): { speaker: string; emoji: string; vibeId: number } | null {
    const session = this.sessions.find((s) => s.sessionId === sessionId);
    if (!session || session.ended) return null;

    // If all planned exchanges are done, push farewell and end
    if (session.exchanges.length >= session.plannedExchanges) {
      session.exchanges.push(16);
      this.endSession(sessionId, nowMs);
      // Return farewell emoji
      const farewell = getVibeById(16)!;
      const speaker =
        session.turn === "initiator"
          ? session.initiatorId
          : session.partnerId;
      return {
        speaker,
        emoji:
          session.turn === "initiator" ? farewell.initiator : farewell.reply,
        vibeId: 16,
      };
    }

    // If forced farewell is queued
    if (session.forceFarewellNext) {
      session.exchanges.push(16);
      session.extraCooldownMs += 5000; // +5s extra cooldown
      this.endSession(sessionId, nowMs);
      const farewell = getVibeById(16)!;
      const speaker =
        session.turn === "initiator"
          ? session.initiatorId
          : session.partnerId;
      return {
        speaker,
        emoji:
          session.turn === "initiator" ? farewell.initiator : farewell.reply,
        vibeId: 16,
      };
    }

    // Pick next vibe using mood biasing
    const vibeId = this.pickNextVibe(session);

    session.exchanges.push(vibeId);

    const vibe = getVibeById(vibeId)!;
    const speaker =
      session.turn === "initiator" ? session.initiatorId : session.partnerId;
    const emoji =
      session.turn === "initiator" ? vibe.initiator : vibe.reply;

    // Check for two positive vibes in a row (bonus)
    const exLen = session.exchanges.length;
    if (exLen >= 2) {
      const prevVibe = getVibeById(session.exchanges[exLen - 2]);
      const currVibe = getVibeById(session.exchanges[exLen - 1]);
      if (prevVibe?.mood === "positive" && currVibe?.mood === "positive") {
        // Flip turn for next
        session.turn = session.turn === "initiator" ? "partner" : "initiator";
        return { speaker: "both", emoji: "🎊", vibeId };
      }
    }

    // Check for two rivalry/snark in a row -> force farewell next turn
    if (exLen >= 2) {
      const prevId = session.exchanges[exLen - 2];
      const currId = session.exchanges[exLen - 1];
      if (
        RIVALRY_SNARK_IDS.includes(prevId) &&
        RIVALRY_SNARK_IDS.includes(currId)
      ) {
        session.forceFarewellNext = true;
      }
    }

    // Flip turn
    session.turn = session.turn === "initiator" ? "partner" : "initiator";

    return { speaker, emoji, vibeId };
  }

  /** Interrupt a session (tool event on one of the participants). */
  interrupt(
    sessionId: number,
    interruptedById: string,
    nowMs: number,
  ): void {
    const session = this.sessions.find((s) => s.sessionId === sessionId);
    if (!session || session.ended) return;

    // 1. Mark ended
    session.ended = true;
    session.interruptedBy = interruptedById;

    // 2. Apply pair cooldown
    const pk = pairKey(session.initiatorId, session.partnerId);
    const cooldownMs =
      WORLD_LIFE_TUNABLES.CHAT_COOLDOWN_PAIR_S * 1000 +
      session.extraCooldownMs;
    this.pairCooldowns.set(pk, nowMs + cooldownMs);

    // 3. Apply per-agent cooldowns to both
    const agentCd = WORLD_LIFE_TUNABLES.CHAT_COOLDOWN_AGENT_S * 1000;
    this.agentCooldowns.set(session.initiatorId, nowMs + agentCd);
    this.agentCooldowns.set(session.partnerId, nowMs + agentCd);
  }

  /** End a session naturally (all exchanges done). */
  endSession(sessionId: number, nowMs: number): void {
    const session = this.sessions.find((s) => s.sessionId === sessionId);
    if (!session || session.ended) return;

    // 1. Mark ended
    session.ended = true;

    // 2. Apply pair cooldown (60s)
    const pk = pairKey(session.initiatorId, session.partnerId);
    const cooldownMs =
      WORLD_LIFE_TUNABLES.CHAT_COOLDOWN_PAIR_S * 1000 +
      session.extraCooldownMs;
    this.pairCooldowns.set(pk, nowMs + cooldownMs);

    // 3. Apply per-agent cooldown (12s) to both
    const agentCd = WORLD_LIFE_TUNABLES.CHAT_COOLDOWN_AGENT_S * 1000;
    this.agentCooldowns.set(session.initiatorId, nowMs + agentCd);
    this.agentCooldowns.set(session.partnerId, nowMs + agentCd);
  }

  /** Get active sessions (not ended). */
  getActiveSessions(): ChatSession[] {
    return this.sessions.filter((s) => !s.ended);
  }

  /** Get session by participant ID (active only). */
  getSessionFor(npcId: string): ChatSession | null {
    return (
      this.sessions.find(
        (s) =>
          !s.ended &&
          (s.initiatorId === npcId || s.partnerId === npcId),
      ) ?? null
    );
  }

  /** Check if an NPC can chat (cooldowns clear, not already in a session). */
  canChat(npcId: string, nowMs: number): boolean {
    // Agent cooldown must be expired
    const agentCd = this.agentCooldowns.get(npcId);
    if (agentCd !== undefined && nowMs < agentCd) return false;

    // Must not already be in an active session
    if (this.getSessionFor(npcId) !== null) return false;

    return true;
  }

  /** Check global cap (max 2 simultaneous). */
  isAtGlobalCap(): boolean {
    return (
      this.getActiveSessions().length >= WORLD_LIFE_TUNABLES.CHAT_GLOBAL_MAX
    );
  }

  /** Cleanup all. */
  destroy(): void {
    this.sessions = [];
    this.sessionCounter = 0;
    this.pairCooldowns.clear();
    this.agentCooldowns.clear();
  }

  // --- Private helpers ---

  private pickNextVibe(session: ChatSession): number {
    // Build weight map for vibes 2-15 (exclude greeting #1 and farewell #16)
    const weights = new Map<number, number>();

    for (let id = 2; id <= 15; id++) {
      weights.set(id, 1);
    }

    // Apply mood biasing
    if (session.initiatorMood === "recent-error") {
      for (const id of ERROR_BOOST_IDS) {
        weights.set(id, (weights.get(id) ?? 1) * 3);
      }
    } else if (session.initiatorMood === "recent-success") {
      for (const id of SUCCESS_BOOST_IDS) {
        weights.set(id, (weights.get(id) ?? 1) * 3);
      }
    }

    // Anti-pattern: no same-emoji ping-pong > 2 turns
    const exLen = session.exchanges.length;
    if (exLen >= 2) {
      const lastTwo = session.exchanges.slice(-2);
      if (lastTwo[0] === lastTwo[1]) {
        weights.delete(lastTwo[0]);
      }
    }

    return weightedPick(weights);
  }
}
