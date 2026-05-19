"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import NpcAvatar from "./NpcAvatar";
import { useAgentPrefsStore } from "../stores/useAgentPrefsStore";
import { useAgentStore } from "../stores/useAgentStore";
import { useGameStore } from "../stores/useGameStore";
import { useContextMenuStore } from "../stores/useContextMenuStore";
import { useNpcStore } from "../stores/useNpcStore";
import { useTerminalStore } from "../stores/useTerminalStore";
import { useToastStore } from "../stores/useToastStore";
import { useWorldBus } from "../stores/useWorldBus";
import type { NpcDef } from "../game/npcs";
import type { AgentProviderId, DynamicNpc } from "../stores/useNpcStore";

function basename(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const trimmed = p.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

// Per-provider chip styling. Looked up by `provider` first; the
// "external" branch is a legacy fallback for NPCs upserted before the
// provider field existed.
type ChipDef = { label: string; bg: string; color: string; title?: string };

const PROVIDER_CHIPS: Record<AgentProviderId | "external" | "live", ChipDef> = {
  cursor: { label: "CURSOR", bg: "#5b3a7c", color: "#fff", title: "Cursor agent" },
  "claude-master": {
    label: "MASTER",
    bg: "#6ee7b7",
    color: "#141827",
    title: "Master Claude (orchestrator)",
  },
  external: {
    label: "EXTERNAL",
    bg: "#2a3150",
    color: "#d5d8ff",
    title: "Detected external session (not launched from Agent Force HQ)",
  },
  claude: { label: "LIVE", bg: "#c9a959", color: "#1b1e2b" },
  live: { label: "LIVE", bg: "#c9a959", color: "#1b1e2b" },
};

function pickProviderChip(
  isDynamic: boolean,
  provider: AgentProviderId | undefined,
  external: boolean,
): ChipDef | null {
  if (!isDynamic) return null;
  if (provider === "cursor") return PROVIDER_CHIPS.cursor;
  if (provider === "claude-master") return PROVIDER_CHIPS["claude-master"];
  if (external) return PROVIDER_CHIPS.external;
  return PROVIDER_CHIPS.live;
}

export default function AgentRoster() {
  const dialogNpcId = useGameStore((s) => s.dialog.npcId);
  const activities = useAgentStore((s) => s.activities);
  const usageByAgent = useAgentStore((s) => s.usageByAgent);
  const errorByAgent = useAgentStore((s) => s.errorByAgent);
  const staticNpcs = useNpcStore((s) => s.staticNpcs);
  const dynamic = useNpcStore((s) => s.dynamic);
  const prefs = useAgentPrefsStore((s) => s.prefs);

  // Put static NPCs first (when there are any — currently the roster is
  // live-only so this just sorts dynamic NPCs). Sub-agents (NPCs with a
  // `parentId`) are rendered nested under their parent below.
  const staticList = [...staticNpcs];
  const dynamicList = Object.values(dynamic);
  const dynamicParents = dynamicList.filter(
    (n) => !("parentId" in n) || !n.parentId,
  );
  // Pinned parents first, then unpinned, preserving insertion order
  // within each bucket. Pin state is keyed by cwd|pid so it survives
  // a session restart (live `id` changes; the project doesn't).
  const isPinned = (n: DynamicNpc): boolean => {
    if (!n.cwd) return false;
    const key = n.pid ? `${n.cwd}|${n.pid}` : n.cwd;
    return !!prefs[key]?.pinned;
  };
  dynamicParents.sort((a, b) => {
    const ap = isPinned(a) ? 1 : 0;
    const bp = isPinned(b) ? 1 : 0;
    return bp - ap;
  });
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
    <div className="panel flex flex-col h-full min-h-0" aria-live="polite" role="log">
      <div className="flex items-center justify-between mb-3">
        <h3 className="pixel-font text-[12px]">AGENTS</h3>
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
            Run{" "}
            <code className="pixel-font text-[10px] px-1 bg-paper-dim border border-ink rounded">
              claude
            </code>{" "}
            in any project, or start one here.
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
            className="pixel-font text-[10px] px-3 py-2 rounded border-2 border-ink bg-accent text-paper-dim hover:bg-[#c9a959] hover:text-paper-dim tracking-wide mb-3"
          >
            + NEW AGENT
          </button>
        </div>
      ) : (
        <>
          <p className="text-[12px] leading-relaxed mb-3 opacity-75">
            Click an agent to chat. Right-click for activity.
          </p>
          <ul className="space-y-2 overflow-y-auto overflow-x-hidden pixel-scroll flex-1 pr-1 min-h-0">
            {[...staticList, ...dynamicParents].map((n) => (
              <AgentRow
                key={n.id}
                n={n}
                isChild={false}
                opts={{
                  activities,
                  usageByAgent,
                  errorByAgent,
                  dialogNpcId,
                  dynamicChildrenByParent,
                }}
              />
            ))}
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
  errorByAgent: Record<string, { message: string; at: number }>;
  dialogNpcId: string | null;
  // Map of parentId → direct children, built once for the whole tree
  // so renderRow can recurse N levels deep without rebuilding it.
  dynamicChildrenByParent: Map<string, DynamicNpc[]>;
}

function AgentRow({
  n,
  isChild,
  opts,
}: {
  n: NpcDef | DynamicNpc;
  isChild: boolean;
  opts: RenderRowOpts;
}) {
  const { activities, usageByAgent, errorByAgent, dialogNpcId, dynamicChildrenByParent } = opts;
  const children = dynamicChildrenByParent?.get(n.id);
  const hasChildren = !!children && children.length > 0;
  const act = activities[n.id];
  const usage = usageByAgent[n.id];
  const isActive = dialogNpcId === n.id;
  const isDynamic = "dynamic" in n;
  const isExternal = isDynamic && (n as DynamicNpc).external === true;
  const avatarSize = isChild ? 24 : 40;
  const dyn = isDynamic ? (n as DynamicNpc) : null;

  // Stable per-project key for prefs (rename + pin). Falls back to
  // null for in-memory-only NPCs (no cwd) — those can't persist
  // their rename across reload, but the rename still works for the
  // current session.
  const prefKey = useAgentPrefsStore((s) => s.keyFor(dyn?.cwd, dyn?.pid));
  const pref = useAgentPrefsStore((s) =>
    prefKey ? s.prefs[prefKey] : undefined,
  );
  const setName = useAgentPrefsStore((s) => s.setName);
  const setPinned = useAgentPrefsStore((s) => s.setPinned);

  // Display name precedence: user-chosen > path.basename(cwd) for
  // anonymous Claude-XXXX defaults > the live agent name.
  const isAnonymousDefault =
    isDynamic && /^Claude-[a-z0-9]+$/i.test(String(n.name));
  const baseFallback = isAnonymousDefault ? basename(dyn?.cwd) : undefined;
  const displayName = pref?.name ?? baseFallback ?? n.name;
  const pinned = !!pref?.pinned;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const beginEdit = () => {
    if (!prefKey) return;
    setDraft(pref?.name ?? displayName);
    setEditing(true);
  };
  const commitEdit = () => {
    if (prefKey) setName(prefKey, draft);
    setEditing(false);
  };
  const cancelEdit = () => setEditing(false);
  const onEditKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };
  // Sub-agents render nested under their parent — bigger left padding
  // plus a thin accent border so the relationship is unmistakable.
  const indent = isChild ? "pl-8 border-l-2 border-accent/40 ml-3" : "";

  const handleClick = () => {
    if (editing) return;
    // Always summon in-world.
    useWorldBus.getState().summonAgent(n.id);

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
            console.debug("[AgentRoster] external agent pid", dyn.pid);
            useToastStore
              .getState()
              .show(
                "This agent is running in another window. Use your OS app switcher to bring it to front.",
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
      className={`agent-row flex items-start gap-3 p-2 rounded ${indent} cursor-pointer hover:bg-paper-dim/60`}
      style={{
        background: isActive ? "rgba(201, 169, 89, 0.25)" : "transparent",
        border: "2px solid " + (isActive ? "#1b1e2b" : "transparent"),
      }}
    >
      <div className="shrink-0">
        <NpcAvatar id={n.id} size={avatarSize} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 gap-y-1 flex-wrap mb-1">
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditKey}
              onBlur={commitEdit}
              onClick={(e) => e.stopPropagation()}
              className="pixel-font bg-paper-dim border border-ink rounded px-1 py-0.5 outline-none"
              style={{ fontSize: isChild ? 11 : 12, maxWidth: 180 }}
              maxLength={40}
              aria-label="Rename agent"
            />
          ) : (
            <span
              className="pixel-font truncate"
              style={{ fontSize: isChild ? 11 : 12 }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                beginEdit();
              }}
              title={
                prefKey
                  ? "Double-click to rename"
                  : "Rename available once the agent reports its working directory"
              }
            >
              {displayName.toUpperCase()}
            </span>
          )}
          {prefKey && !isChild && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setPinned(prefKey, !pinned);
              }}
              className="pixel-font text-[10px] px-1 py-0.5 rounded"
              style={{
                background: pinned ? "#c9a959" : "transparent",
                color: pinned ? "#1b1e2b" : "var(--ink-soft, #888)",
                border: "1px solid " + (pinned ? "#1b1e2b" : "transparent"),
              }}
              title={pinned ? "Unpin from top" : "Pin to top"}
              aria-pressed={pinned}
            >
              {pinned ? "★" : "☆"}
            </button>
          )}
          {(() => {
            const chip = pickProviderChip(isDynamic, dyn?.provider, isExternal);
            if (!chip) return null;
            return (
              <span
                className="pixel-font text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: chip.bg, color: chip.color }}
                title={chip.title}
              >
                {chip.label}
              </span>
            );
          })()}
        </div>
        {(isActive || hasChildren || errorByAgent[n.id]) && (
          <div className="flex items-center flex-wrap gap-1 mt-0.5 mb-1 text-[10px]">
            {isActive && (
              <span className="pixel-font text-[10px] px-1.5 py-0.5 rounded bg-ink text-paper">
                ▸ TALKING
              </span>
            )}
            {hasChildren && (
              <span
                className="pixel-font text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: "#1b1e2b", color: "#f4ecd8" }}
                title="This agent has spawned sub-agents"
              >
                ↳ HELPER
              </span>
            )}
            {errorByAgent[n.id] && (
              <span
                role="alert"
                aria-live="assertive"
                aria-label={errorByAgent[n.id].message}
                className="pixel-font text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: "#ef4444", color: "#fff" }}
                title={errorByAgent[n.id].message}
              >
                ! ERROR
              </span>
            )}
          </div>
        )}
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
            {children.map((child) => (
              <AgentRow key={child.id} n={child} isChild opts={opts} />
            ))}
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
