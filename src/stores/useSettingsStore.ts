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
  /** When true, "EXPORT TRACE" includes user-prompt and tool-input/result
   *  text in the JSONL. Off by default — even with everything kept in
   *  memory only, downloading prompts to disk crosses a privacy line we
   *  want to flag explicitly. */
  exportIncludePrompts: boolean;

  setWorldLifeV2: (v: boolean) => void;
  toggleWorldLifeV2: () => boolean;
  setCalmMode: (v: boolean) => void;
  toggleCalmMode: () => boolean;
  setExportIncludePrompts: (v: boolean) => void;
}

const EXPORT_PROMPTS_KEY = "agentquest:exportIncludePrompts";

function loadExportIncludePrompts(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(EXPORT_PROMPTS_KEY) === "1";
  } catch {
    return false;
  }
}

function persistExportIncludePrompts(v: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EXPORT_PROMPTS_KEY, v ? "1" : "0");
  } catch {
    // ignore
  }
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  worldLifeV2: false,
  calmMode: false,
  exportIncludePrompts: loadExportIncludePrompts(),

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
  setExportIncludePrompts: (v) => {
    persistExportIncludePrompts(v);
    set({ exportIncludePrompts: v });
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
