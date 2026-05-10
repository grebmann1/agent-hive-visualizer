"use client";

import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { npcById } from "../game/npcs";
import { useActivityModalStore } from "../stores/useActivityModalStore";
import { useContextMenuStore, type ContextMenuItem } from "../stores/useContextMenuStore";
import { useGameStore } from "../stores/useGameStore";
import { useNpcStore } from "../stores/useNpcStore";
import { useWorldBus } from "../stores/useWorldBus";

// Generic right-click menu. Appends items in `buildItems`.
function buildItems(targetNpcId: string): ContextMenuItem[] {
  const isFollowing =
    useGameStore.getState().followNpcId === targetNpcId;
  return [
    {
      id: "call",
      label: "Call to center",
      onSelect: () => useWorldBus.getState().summonAgent(targetNpcId),
    },
    {
      id: "follow",
      label: isFollowing ? "Stop following" : "Follow with camera",
      onSelect: () =>
        useGameStore
          .getState()
          .setFollowNpc(isFollowing ? null : targetNpcId),
    },
    {
      id: "activity",
      label: "Activity…",
      onSelect: () => useActivityModalStore.getState().openFor(targetNpcId),
    },
  ];
}

export default function ContextMenu() {
  const open = useContextMenuStore((s) => s.open);
  const clientX = useContextMenuStore((s) => s.clientX);
  const clientY = useContextMenuStore((s) => s.clientY);
  const targetNpcId = useContextMenuStore((s) => s.targetNpcId);
  const anchor = useContextMenuStore((s) => s.anchor);
  const close = useContextMenuStore((s) => s.close);

  const menuRef = useRef<HTMLDivElement | null>(null);

  // Subscribing to the dynamic-NPC store means the header updates if a
  // dynamic NPC's name changes while the menu is open (rare, but cheap).
  const dynamics = useNpcStore((s) => s.dynamic);

  const items = useMemo(
    () => (targetNpcId ? buildItems(targetNpcId) : []),
    [targetNpcId],
  );

  const targetName = useMemo(() => {
    if (!targetNpcId) return null;
    const dyn = dynamics[targetNpcId];
    if (dyn) return dyn.name;
    return npcById(targetNpcId)?.name ?? targetNpcId;
  }, [targetNpcId, dynamics]);

  // Close on outside click, scroll, Escape. Capture phase so the menu
  // closes before the *next* menu open sees the click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (menuRef.current.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onScroll = () => close();
    // Wheel-zooming the canvas or alt-tabbing to another window also feels
    // like the user is "moving on" — close in those cases too.
    const onWheelOrBlur = () => useContextMenuStore.getState().close();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("wheel", onWheelOrBlur, { capture: true, passive: true });
    window.addEventListener("blur", onWheelOrBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("wheel", onWheelOrBlur, { capture: true } as EventListenerOptions);
      window.removeEventListener("blur", onWheelOrBlur);
    };
  }, [open, close]);

  if (!open) return null;

  // Two render modes:
  //  * With an anchor → portal INTO the anchor (game panel) and position
  //    absolutely relative to it. Menu physically cannot escape the panel.
  //  * Without an anchor → fixed-to-viewport (roster right-click).
  // Height estimate now includes a ~24px header row for the agent name.
  const HEADER_H = 26;
  const estimatedH = HEADER_H + Math.max(40, items.length * 32 + 8);
  const estimatedW = 180;

  const inner = (
    <>
      {targetName && (
        <div
          className="pixel-font text-[10px] px-3 py-1.5 text-accent tracking-wide border-b-2 border-ink mb-1 truncate"
          title={targetName}
        >
          ◆ {targetName.toUpperCase()}
        </div>
      )}
      {items.length === 0 ? (
        <div className="pixel-font text-[10px] px-3 py-2 text-ink-soft">
          No actions
        </div>
      ) : (
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  item.onSelect();
                  close();
                }}
                className="w-full text-left pixel-font text-[10px] px-3 py-2 hover:bg-paper-dim disabled:opacity-40 disabled:cursor-not-allowed tracking-wide rounded"
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  if (anchor) {
    return createPortal(
      <div
        ref={menuRef}
        className="panel pointer-events-auto select-none"
        style={{
          position: "absolute",
          minWidth: estimatedW,
          padding: 4,
          zIndex: 100,
          ...computePosition(anchor, clientX, clientY, estimatedW, estimatedH),
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {inner}
      </div>,
      anchor,
    );
  }

  // No anchor — render at top level, positioned fixed-to-viewport.
  return (
    <div
      ref={menuRef}
      className="fixed panel pointer-events-auto select-none"
      style={{
        left: Math.min(Math.max(8, clientX), window.innerWidth - estimatedW - 8),
        top: Math.min(Math.max(8, clientY), window.innerHeight - estimatedH - 8),
        minWidth: estimatedW,
        padding: 4,
        zIndex: 100,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {inner}
    </div>
  );
}

function computePosition(
  anchor: HTMLElement | null,
  clientX: number,
  clientY: number,
  w: number,
  h: number,
): { left: number; top: number } {
  if (!anchor) return { left: 0, top: 0 };
  const rect = anchor.getBoundingClientRect();
  // Convert viewport coords to coords relative to the anchor.
  const relX = clientX - rect.left;
  const relY = clientY - rect.top;
  const PAD = 4;
  const maxLeft = Math.max(PAD, rect.width - w - PAD);
  const maxTop = Math.max(PAD, rect.height - h - PAD);
  return {
    left: Math.min(Math.max(PAD, relX), maxLeft),
    top: Math.min(Math.max(PAD, relY), maxTop),
  };
}
