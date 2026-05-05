// Modal that lists all the recorded events for a specific NPC.

import { create } from "zustand";

interface ActivityModalState {
  open: boolean;
  npcId: string | null;

  openFor: (npcId: string) => void;
  close: () => void;
}

export const useActivityModalStore = create<ActivityModalState>((set) => ({
  open: false,
  npcId: null,

  openFor: (npcId) => set({ open: true, npcId }),
  close: () => set({ open: false, npcId: null }),
}));
