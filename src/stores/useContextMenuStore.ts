// Generic right-click menu state. Kept deliberately simple: the menu has a
// target id (the NPC it's acting on) and a screen position. Menu items are
// rendered by the ContextMenu component based on the target id — it decides
// which options apply (e.g. skip "call" for the receptionist).

import { create } from "zustand";

export interface ContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface ContextMenuState {
  open: boolean;
  // Viewport (clientX/Y) coords at the time of the click. The ContextMenu
  // component translates these to be relative to `anchor` if one was given.
  clientX: number;
  clientY: number;
  // The NPC id the menu is targeting. Pre-computed items are rendered by
  // <ContextMenu/> using this id so callers don't need to build the items.
  targetNpcId: string | null;
  // If set, the menu is portalled INTO this element and positioned
  // absolutely relative to it. This confines the menu physically to the
  // game panel DOM so it cannot drift over the sidebar or cause scroll.
  anchor: HTMLElement | null;

  openAt: (
    clientX: number,
    clientY: number,
    targetNpcId: string,
    anchor?: HTMLElement | null,
  ) => void;
  close: () => void;
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  open: false,
  clientX: 0,
  clientY: 0,
  targetNpcId: null,
  anchor: null,

  openAt: (clientX, clientY, targetNpcId, anchor = null) =>
    set({ open: true, clientX, clientY, targetNpcId, anchor }),
  close: () => set({ open: false, targetNpcId: null, anchor: null }),
}));
