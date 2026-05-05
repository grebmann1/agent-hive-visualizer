"use client";

// First-launch nudge: asks the user to install AgentQuest's hooks into
// `~/.claude/settings.json` so we get real-time claude events. Hidden
// automatically once hooks are detected. Dismissal is rate-limited to
// 24 h via localStorage so we don't pester on every boot.

import { useCallback, useEffect, useState } from "react";
import { useToastStore } from "../stores/useToastStore";

const DISMISS_KEY = "agentquest:hooksBannerDismissedAt";
const DISMISS_TTL_MS = 24 * 60 * 60 * 1000;

type Status =
  | { kind: "loading" }
  | { kind: "hidden" } // hooks installed OR user dismissed recently
  | { kind: "offer" } // show the banner
  | { kind: "installing" }
  | { kind: "error"; message: string; settingsPath?: string };

export default function HookSetupBanner() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [showExplainer, setShowExplainer] = useState(false);

  const refresh = useCallback(async () => {
    const bridge = window.agentquest;
    if (!bridge?.hooks) {
      setStatus({ kind: "hidden" });
      return;
    }
    const res = await bridge.hooks.isInstalled();
    if (res.installed) {
      setStatus({ kind: "hidden" });
      return;
    }
    // Check dismissal freshness.
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      if (raw) {
        const ts = Number(raw);
        if (Number.isFinite(ts) && Date.now() - ts < DISMISS_TTL_MS) {
          setStatus({ kind: "hidden" });
          return;
        }
      }
    } catch {
      // localStorage could be blocked in strict environments — just
      // fall through to showing the banner.
    }
    setStatus({ kind: "offer" });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const install = async () => {
    setStatus({ kind: "installing" });
    const bridge = window.agentquest;
    if (!bridge?.hooks) {
      setStatus({
        kind: "error",
        message: "Running outside Electron — hooks are unavailable.",
      });
      return;
    }
    const res = await bridge.hooks.install();
    if (res.ok) {
      useToastStore
        .getState()
        .show("Hooks installed — live agent events are on.", "info");
      setStatus({ kind: "hidden" });
      return;
    }
    setStatus({
      kind: "error",
      message: res.error ?? "Install failed for an unknown reason.",
    });
  };

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // ignore
    }
    setStatus({ kind: "hidden" });
  };

  const openSettings = async () => {
    await window.agentquest?.hooks?.openSettings();
  };

  if (status.kind === "loading" || status.kind === "hidden") return null;

  return (
    <>
      <div className="panel-dark px-4 py-3 flex items-center gap-4 text-[12px]">
        <div className="pixel-font text-[11px] text-accent tracking-wide">
          ◆ LIVE HOOKS NOT INSTALLED
        </div>
        <div className="flex-1 opacity-90">
          AgentQuest hasn&apos;t wired itself into Claude yet. Install hooks to
          stream every agent event in real-time — no polling, no truncation.
        </div>
        {status.kind === "offer" && (
          <>
            <button
              type="button"
              onClick={install}
              className="pixel-font text-[10px] px-3 py-2 rounded border-2 border-ink bg-accent text-ink hover:bg-accent-dark tracking-wide"
            >
              INSTALL HOOKS
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="pixel-font text-[10px] px-2 py-1 opacity-60 hover:opacity-100 tracking-wide"
            >
              NOT NOW
            </button>
            <button
              type="button"
              onClick={() => setShowExplainer(true)}
              className="pixel-font text-[10px] px-2 py-1 opacity-70 hover:opacity-100 underline tracking-wide"
            >
              WHAT DOES THIS DO?
            </button>
          </>
        )}
        {status.kind === "installing" && (
          <div className="pixel-font text-[10px] opacity-70">INSTALLING…</div>
        )}
        {status.kind === "error" && (
          <>
            <div className="text-[11px] text-red-300 italic max-w-[40%] truncate">
              {status.message}
            </div>
            <button
              type="button"
              onClick={openSettings}
              className="pixel-font text-[10px] px-2 py-1 rounded border-2 border-ink bg-paper-dim tracking-wide"
            >
              OPEN SETTINGS.JSON
            </button>
            <button
              type="button"
              onClick={() => setStatus({ kind: "offer" })}
              className="pixel-font text-[10px] px-2 py-1 opacity-70 hover:opacity-100 tracking-wide"
            >
              RETRY
            </button>
          </>
        )}
      </div>

      {showExplainer && (
        <div
          className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShowExplainer(false)}
        >
          <div
            className="dialog-box w-[min(92vw,520px)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="pixel-font text-[13px] text-accent-dark">
                ◆ WHAT AGENTQUEST INSTALLS
              </h2>
              <button
                type="button"
                onClick={() => setShowExplainer(false)}
                className="pixel-font text-[9px] text-ink-soft hover:text-ink underline"
              >
                [CLOSE]
              </button>
            </div>
            <ul className="text-[13px] leading-relaxed list-disc pl-5 space-y-2">
              <li>
                Adds six hook entries to{" "}
                <code className="text-[12px] px-1 bg-paper-dim border border-ink rounded">
                  ~/.claude/settings.json
                </code>{" "}
                (SessionStart, PreToolUse, PostToolUse, PostToolUseFailure,
                Stop, SessionEnd).
              </li>
              <li>
                Installs a small relay script at{" "}
                <code className="text-[12px] px-1 bg-paper-dim border border-ink rounded">
                  ~/.agentquest/bin/post-hook.sh
                </code>
                .
              </li>
              <li>
                Each hook POSTs to{" "}
                <code className="text-[12px] px-1 bg-paper-dim border border-ink rounded">
                  http://127.0.0.1:47329
                </code>{" "}
                — loopback only. No outbound network traffic.
              </li>
              <li>
                A one-time backup of your existing settings is saved to{" "}
                <code className="text-[12px] px-1 bg-paper-dim border border-ink rounded">
                  ~/.claude/settings.json.bak.agentquest
                </code>
                . Uninstall cleanly removes the hooks and preserves the rest.
              </li>
            </ul>
            <div className="mt-4 pt-3 border-t-2 border-ink flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowExplainer(false)}
                className="pixel-font text-[10px] px-3 py-2 rounded border-2 border-ink bg-paper hover:bg-paper-dim tracking-wide"
              >
                CLOSE
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
