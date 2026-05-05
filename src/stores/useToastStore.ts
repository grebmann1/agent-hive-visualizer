// One-slot transient toast displayed over the game panel. Used for
// non-blocking feedback (e.g. "couldn't focus that terminal", "pool full").

import { create } from "zustand";

interface ToastStoreState {
  message: string | null;
  tone: "info" | "warn" | "error";
  show: (message: string, tone?: "info" | "warn" | "error", ms?: number) => void;
  hide: () => void;
}

let hideTimer: ReturnType<typeof setTimeout> | null = null;

export const useToastStore = create<ToastStoreState>((set) => ({
  message: null,
  tone: "info",
  show(message, tone = "info", ms = 3000) {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    set({ message, tone });
    hideTimer = setTimeout(() => {
      hideTimer = null;
      set({ message: null });
    }, ms);
  },
  hide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    set({ message: null });
  },
}));
