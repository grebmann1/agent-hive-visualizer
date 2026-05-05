// Tiny React → Phaser event bus.
//
// React components (AgentRoster, DialogBox for the receptionist, etc.) can't
// call WorldScene methods directly without pulling Phaser into the client
// bundle in weird ways. Instead they push an intent here and WorldScene
// subscribes in its create() and drains the queue each tick.
//
// The bus is intentionally narrow: a single monotonically-increasing counter
// per action-kind, keyed by `targetId`, so subscribers can diff by value and
// fire once per increment.

import { create } from "zustand";

interface WorldBusState {
  // Each time `summonAgent(id)` is called we bump the counter for that id.
  // WorldScene watches the whole map and reacts to any id whose counter grew.
  summonTick: Record<string, number>;
  summonAgent: (id: string) => void;
}

export const useWorldBus = create<WorldBusState>((set) => ({
  summonTick: {},
  summonAgent: (id) =>
    set((s) => ({
      summonTick: {
        ...s.summonTick,
        [id]: (s.summonTick[id] ?? 0) + 1,
      },
    })),
}));
