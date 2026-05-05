"use client";

import { type MouseEvent as ReactMouseEvent } from "react";
import NpcAvatar from "./NpcAvatar";
import { useAgentStore } from "../stores/useAgentStore";
import { useGameStore } from "../stores/useGameStore";
import { useContextMenuStore } from "../stores/useContextMenuStore";
import { useNpcStore } from "../stores/useNpcStore";
import { useTerminalStore } from "../stores/useTerminalStore";
import { useToastStore } from "../stores/useToastStore";
import { useWorldBus } from "../stores/useWorldBus";
import type { NpcDef } from "../game/npcs";
import type { DynamicNpc } from "../stores/useNpcStore";

export default function AgentRoster() {
  const dialogNpcId = useGameStore((s) => s.dialog.npcId);
  const activities = useAgentStore((s) => s.activities);
  const usageByAgent = useAgentStore((s) => s.usageByAgent);
  const staticNpcs = useNpcStore((s) => s.staticNpcs);
  const dynamic = useNpcStore((s) => s.dynamic);

  // Put static NPCs first (when there are any — currently the roster is
  // live-only so this just sorts dynamic NPCs). Sub-agents (NPCs with a
  // `parentId`) are rendered nested under their parent below.
  const staticList = [...staticNpcs];
  const dynamicList = Object.values(dynamic);
  const dynamicParents = dynamicList.filter(
    (n) => !("parentId" in n) || !n.parentId,
  );
  const dynamicChildrenByParent = new Map<string, typeof dynamicList>();
  for (const n of dynamicList) {
    const p = (n as { parentId?: string }).parentId;
    if (!p) continue;
    const bucket = dynamicChildrenByParent.get(p) ?? [];
    bucket.push(n);
    dynamicChildrenByParent.set(p, bucket);
  }
  const all = [...staticList, ...dynamicList];

  return (
    <div className="panel flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="pixel-font text-[12px]">▸ AGENTS</h3>
        <span className="pixel-font text-[9px] text-ink-soft">
          {all.length} TOTAL
        </span>
      </div>
      {all.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
          <div className="text-[28px] mb-3">🪄</div>
          <p className="pixel-font text-[10px] mb-2 tracking-wide">
            NO AGENTS YET
          </p>
          <p className="text-[12px] leading-relaxed opacity-75 mb-3">
            Start a Claude session from inside AgentQuest — or press{" "}
            <span className="pixel-font text-[9px] px-1 bg-paper-dim border border-ink rounded">
              ⌘N
            </span>{" "}
            anywhere.
          </p>
          <button
            type="button"
            onClick={() => {
              // Opening the terminal split with no tabs will prompt the
              // empty state's New Agent button; simpler to just open the
              // split and let MainSplit's shortcut show the modal.
              useTerminalStore.getState().setSplitOpen(true);
              window.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: "n",
                  metaKey: navigator.platform.toLowerCase().includes("mac"),
                  ctrlKey: !navigator.platform.toLowerCase().includes("mac"),
                }),
              );
            }}
            className="pixel-font text-[10px] px-3 py-2 rounded border-2 border-ink bg-accent text-ink hover:bg-accent-dark tracking-wide mb-3"
          >
            + NEW AGENT
          </button>
        </div>
      ) : (
        <>
          <p className="text-[12px] leading-relaxed mb-3 opacity-75">
            Click an agent to chat. Right-click for activity.
          </p>
          <ul className="space-y-2 overflow-y-auto pixel-scroll flex-1 pr-1 min-h-0">
            {[...staticList, ...dynamicParents].map((n) =>
              renderRow(n, false, {
                activities,
                usageByAgent,
                dialogNpcId,
                hasChildren: dynamicChildrenByParent.has(n.id),
                children: dynamicChildrenByParent.get(n.id),
                dynamicChildrenByParent,
              }),
            )}
          </ul>
        </>
      )}
    </div>
  );
}

interface RenderRowOpts {
  activities: Record<string, { bubble: string }>;
  usageByAgent: Record<
    string,
    { input: number; output: number; cacheRead: number }
  >;
  dialogNpcId: string | null;
  hasChildren?: boolean;
  children?: DynamicNpc[];
  dynamicChildrenByParent?: Map<string, DynamicNpc[]>;
}

function renderRow(
  n: NpcDef | DynamicNpc,
  isChild: boolean,
  opts: RenderRowOpts,
) {
  const { activities, usageByAgent, dialogNpcId, hasChildren, children } = opts;
  const act = activities[n.id];
  const usage = usageByAgent[n.id];
  const isActive = dialogNpcId === n.id;
  const isDynamic = "dynamic" in n;
  const isExternal = isDynamic && (n as DynamicNpc).external === true;
  const avatarSize = isChild ? 24 : 40;
  const indent = isChild ? "pl-6" : "";

  const handleClick = () => {
    // Always summon in-world.
    useWorldBus.getState().summonAgent(n.id);

    const dyn = isDynamic ? (n as DynamicNpc) : null;
    const terminalId = dyn?.terminalId;
    if (terminalId) {
      // Terminal-linked: focus our own embedded tab.
      const ts = useTerminalStore.getState();
      if (ts.terminals[terminalId]) {
        ts.setActive(terminalId);
        ts.setSplitOpen(true);
      }
      return;
    }
    if (isExternal && dyn?.pid) {
      // External: try to raise whichever app (iTerm/Cursor/VS Code/etc)
      // is running this claude. If we can't identify the host, toast a
      // helpful hint — summon still fired so the NPC visit works.
      const bridge = window.agentquest;
      if (bridge?.focusExternalHost) {
        bridge.focusExternalHost(dyn.pid).then((res) => {
          if (!res.ok) {
            useToastStore
              .getState()
              .show(
                `This agent runs outside AgentQuest (PID ${dyn.pid}) — switch via ⌘⇥.`,
                "warn",
              );
          }
        });
      }
    }
  };

  const handleContextMenu = (e: ReactMouseEvent<HTMLLIElement>) => {
    e.preventDefault();
    useContextMenuStore.getState().openAt(e.clientX, e.clientY, n.id);
  };

  return (
    <li
      key={n.id}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title="Click to call this agent over"
      className={`flex items-start gap-3 p-2 rounded ${indent} cursor-pointer hover:bg-paper-dim/60`}
      style={{
        background: isActive ? "rgba(201, 169, 89, 0.25)" : "transparent",
        border: "2px solid " + (isActive ? "#1b1e2b" : "transparent"),
      }}
    >
      <div className="shrink-0">
        <NpcAvatar
          baseTile={n.baseTile}
          tint={n.tint}
          size={avatarSize}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <span
            className="pixel-font"
            style={{ fontSize: isChild ? 10 : 11 }}
          >
            {n.name.toUpperCase()}
          </span>
          {isActive && (
            <span className="pixel-font text-[8px] px-1.5 py-0.5 rounded bg-ink text-paper">
              TALKING
            </span>
          )}
          {isExternal ? (
            <span
              className="pixel-font text-[8px] px-1.5 py-0.5 rounded"
              style={{ background: "#2a3150", color: "#8e94bf" }}
              title="Detected external session (not launched from AgentQuest)"
            >
              EXT
            </span>
          ) : (
            isDynamic && (
              <span
                className="pixel-font text-[8px] px-1.5 py-0.5 rounded"
                style={{ background: "#c9a959", color: "#1b1e2b" }}
              >
                LIVE
              </span>
            )
          )}
          {hasChildren && (
            <span
              className="pixel-font text-[8px] px-1.5 py-0.5 rounded"
              style={{ background: "#1b1e2b", color: "#f4ecd8" }}
              title="This agent has spawned sub-agents"
            >
              +HELPER
            </span>
          )}
        </div>
        <div
          className="opacity-75 truncate"
          style={{ fontSize: isChild ? 10 : 11 }}
        >
          {n.role}
        </div>
        {act && (
          <div
            className="italic text-ink-soft truncate mt-1"
            style={{ fontSize: isChild ? 9 : 10 }}
          >
            {act.bubble}
          </div>
        )}
        {usage && (usage.input > 0 || usage.output > 0) && (
          <div
            className="text-ink-soft mt-1 tabular-nums"
            style={{ fontSize: isChild ? 9 : 10 }}
            title={`Input ${usage.input} · Output ${usage.output} · Cache ${usage.cacheRead}`}
          >
            ↓{formatTokens(usage.input)} ↑{formatTokens(usage.output)}
          </div>
        )}
        {children && children.length > 0 && (
          <ul className="mt-2 space-y-1">
            {children.map((child) => renderRow(child, true, opts))}
          </ul>
        )}
      </div>
    </li>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
