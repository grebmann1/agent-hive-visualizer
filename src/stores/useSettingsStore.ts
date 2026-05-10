import { create } from "zustand";

// Runtime feature flags + user preferences.
//
// Lives separately from `useGameStore` (dialog/follow state) so the
// world-life rollout can land additional flags without bloating an
// already-busy store. Default is "everything off" so a fresh install
// behaves exactly like today.
//
// To flip a flag at runtime from devtools:
//   useSettingsStore.getState().setWorldLifeV2(true)
// (The store assigns itself to `window.__settings` in dev for
// one-line toggling — see the bottom of this file.)
interface SettingsState {
  /** Stage 1 of the world-life redesign (spec §2 + §9). When false,
   *  WorldScene runs unchanged. When true, a 2 Hz evaluator updates
   *  per-NPC FSM states and emits the structured transition log. */
  worldLifeV2: boolean;
  /** Calm mode (spec §7). When true, disables: ambient idle anims,
   *  chit-chat bubbles, decorative parallax, particle FX. Keeps: agent
   *  presence, status icons, task progress, error states, dialogs. */
  calmMode: boolean;

  setWorldLifeV2: (v: boolean) => void;
  toggleWorldLifeV2: () => boolean;
  setCalmMode: (v: boolean) => void;
  toggleCalmMode: () => boolean;
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  worldLifeV2: false,
  calmMode: false,

  setWorldLifeV2: (v) => set({ worldLifeV2: v }),
  toggleWorldLifeV2: () => {
    const next = !get().worldLifeV2;
    set({ worldLifeV2: next });
    return next;
  },
  setCalmMode: (v) => set({ calmMode: v }),
  toggleCalmMode: () => {
    const next = !get().calmMode;
    set({ calmMode: next });
    return next;
  },
}));

// Auto-enable calm mode when prefers-reduced-motion is active.
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (mql.matches) useSettingsStore.getState().setCalmMode(true);
  const onChange = (e: MediaQueryListEvent) => {
    useSettingsStore.getState().setCalmMode(e.matches);
  };
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
  }
}

// Dev-time hook so a reviewer can flip the flag from the browser
// devtools without rebuilding. Wrapped in a window guard so SSR (and
// any future Node test runs) don't crash, and additionally gated on
// NODE_ENV so production bundles don't leak the store reference onto
// `window`.
if (
  process.env.NODE_ENV !== "production" &&
  typeof window !== "undefined"
) {
  (window as unknown as { __settings?: typeof useSettingsStore }).__settings =
    useSettingsStore;
}
