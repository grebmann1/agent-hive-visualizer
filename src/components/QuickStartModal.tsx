"use client";

import { useEffect, useState } from "react";
import { useTerminalStore } from "../stores/useTerminalStore";

// Recents are stored in localStorage so the player's frequent projects
// stay one click away across app restarts.
const RECENTS_KEY = "agentquest:recent-cwds:v1";
const RECENTS_MAX = 6;

interface Preset {
  id: string;
  label: string;
  // Command sent to the shell. Empty = just spawn a plain shell (no claude).
  command: string;
  description: string;
}

const PRESETS: Preset[] = [
  {
    id: "chat",
    label: "Chat with Claude",
    command: "claude\n",
    description: "Start an interactive Claude session in this folder.",
  },
  {
    id: "dangerous",
    label: "Chat with Claude --dangerously-skip-permissions",
    command: "claude --dangerously-skip-permissions\n",
    description:
      "Start Claude with permission prompts disabled — use only in trusted repos.",
  },
  {
    id: "review",
    label: "Review recent changes",
    command:
      'claude "Review the uncommitted changes in this repo and flag anything risky."\n',
    description: "Spawns Claude with a prompt summarizing git diff.",
  },
  {
    id: "tests",
    label: "Write tests",
    command:
      'claude "Look at the recently changed files and suggest unit tests."\n',
    description: "Kicks off a test-writing session.",
  },
  {
    id: "shell",
    label: "Shell only",
    command: "",
    description: "Just a plain shell — no Claude. Run whatever you want.",
  },
];

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function saveRecent(cwd: string) {
  try {
    const cur = loadRecents().filter((c) => c !== cwd);
    cur.unshift(cwd);
    localStorage.setItem(
      RECENTS_KEY,
      JSON.stringify(cur.slice(0, RECENTS_MAX)),
    );
  } catch {
    // ignore
  }
}

function shortCwd(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return "…/" + parts.slice(-2).join("/");
}

export default function QuickStartModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const openTerminal = useTerminalStore((s) => s.openTerminal);
  const [cwd, setCwd] = useState<string>("");
  const [preset, setPreset] = useState<string>("chat");
  const [recents, setRecents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRecents(loadRecents());
    setError(null);
    setBusy(false);
    const last = loadRecents()[0];
    if (last && !cwd) setCwd(last);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);

  if (!open) return null;

  const browse = async () => {
    const res = await window.agentquest?.pickDirectory?.();
    if (res && !res.canceled && res.path) {
      setCwd(res.path);
    }
  };

  const launch = async () => {
    if (!cwd) {
      setError("Pick a working directory first.");
      return;
    }
    setBusy(true);
    setError(null);
    const presetDef = PRESETS.find((p) => p.id === preset) ?? PRESETS[0];
    const title = cwd.split("/").filter(Boolean).pop() || "shell";
    const id = await openTerminal({ cwd, title });
    if (!id) {
      setError("Could not spawn a terminal. Is Electron running?");
      setBusy(false);
      return;
    }
    saveRecent(cwd);
    // Wait a moment for the PTY shell to prompt before injecting the
    // command, otherwise the first chars can race the shell startup banner.
    if (presetDef.command) {
      setTimeout(() => {
        window.agentquest?.terminal?.write(id, presetDef.command);
      }, 450);
    }
    setBusy(false);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="dialog-box w-[min(92vw,520px)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="pixel-font text-[13px] text-accent-dark">
            ◆ NEW AGENT
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="pixel-font text-[9px] text-ink-soft hover:text-ink underline"
          >
            [CLOSE]
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="pixel-font text-[9px] text-ink-soft tracking-wide block mb-1">
              WORKING DIRECTORY
            </label>
            <div className="flex gap-2">
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/Users/you/code/my-repo"
                className="flex-1 bg-paper-dim border-2 border-ink rounded px-2 py-1.5 text-[12px] outline-none focus:bg-paper font-mono"
              />
              <button
                type="button"
                onClick={browse}
                className="pixel-font text-[9px] px-2 py-1 rounded border-2 border-ink bg-paper hover:bg-paper-dim tracking-wide"
              >
                BROWSE…
              </button>
            </div>
            {recents.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {recents.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setCwd(r)}
                    className="text-[10px] px-2 py-0.5 rounded border border-ink bg-paper-dim hover:bg-paper font-mono"
                    title={r}
                  >
                    {shortCwd(r)}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="pixel-font text-[9px] text-ink-soft tracking-wide block mb-1">
              START COMMAND
            </label>
            <div className="space-y-1">
              {PRESETS.map((p) => (
                <label
                  key={p.id}
                  className="flex items-start gap-2 p-2 rounded border-2 cursor-pointer hover:bg-paper-dim"
                  style={{
                    borderColor:
                      preset === p.id ? "var(--accent)" : "var(--border)",
                    background:
                      preset === p.id
                        ? "rgba(110, 231, 183, 0.08)"
                        : "transparent",
                  }}
                >
                  <input
                    type="radio"
                    name="preset"
                    value={p.id}
                    checked={preset === p.id}
                    onChange={() => setPreset(p.id)}
                    className="mt-0.5"
                  />
                  <div className="flex-1">
                    <div className="pixel-font text-[10px] tracking-wide">
                      {p.label.toUpperCase()}
                    </div>
                    <div className="text-[11px] opacity-70 mt-0.5">
                      {p.description}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {error && (
            <div className="text-[11px] text-red-400 pixel-font tracking-wide">
              ! {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t-2 border-ink">
            <button
              type="button"
              onClick={onClose}
              className="pixel-font text-[9px] px-3 py-2 rounded border-2 border-ink bg-paper hover:bg-paper-dim tracking-wide"
            >
              CANCEL
            </button>
            <button
              type="button"
              onClick={launch}
              disabled={busy || !cwd}
              className="pixel-font text-[9px] px-3 py-2 rounded border-2 border-ink bg-accent text-paper-dim hover:bg-accent-dark hover:text-paper-dim tracking-wide disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "STARTING…" : "▸ LAUNCH"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
