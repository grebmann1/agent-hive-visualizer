"use client";

// First-launch nudge: asks the user to install Agent Force HQ's hooks into
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

  useEffect(() => {
    if (!showExplainer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowExplainer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showExplainer]);

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
      message:
        res.error ??
        "Install failed. Try Open settings.json and re-run, or restart Agent Force HQ.",
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
      <div className="absolute top-0 left-0 right-0 z-[90] panel px-5 py-3 flex items-center gap-5 text-[12px] shadow-lg">
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-[18px] leading-none">📡</span>
          <div>
            <div className="pixel-font text-[11px] text-accent-dark tracking-wide leading-tight">
              NOT CONNECTED
            </div>
            <div className="text-[11px] text-ink-soft leading-tight mt-0.5">
              Live hooks inactive
            </div>
          </div>
        </div>
        <div className="flex-1 text-ink-soft text-[12px] leading-snug">
          Install hooks to see every Claude session in real-time.
          Everything stays local — no network traffic.
        </div>
        {status.kind === "offer" && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={install}
              className="btn text-[10px] px-4 py-2"
            >
              INSTALL HOOKS
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="btn-ghost pixel-font text-[10px] px-3 py-2 rounded border-2 border-[var(--border)] opacity-70 hover:opacity-100"
            >
              LATER
            </button>
            <button
              type="button"
              onClick={() => setShowExplainer(true)}
              className="pixel-font text-[10px] px-2 py-1.5 text-ink-soft hover:text-ink underline decoration-dotted underline-offset-2"
            >
              LEARN MORE
            </button>
          </div>
        )}
        {status.kind === "installing" && (
          <div className="pixel-font text-[10px] text-accent flex items-center gap-2 shrink-0">
            <span className="inline-block animate-spin">◇</span> INSTALLING…
          </div>
        )}
        {status.kind === "error" && (
          <div className="flex items-center gap-2 shrink-0">
            <div className="text-[11px] text-red-400 max-w-[220px] truncate">
              {status.message}
            </div>
            <button
              type="button"
              onClick={openSettings}
              className="btn-ghost pixel-font text-[10px] px-3 py-2 rounded border-2 border-[var(--border)]"
            >
              OPEN SETTINGS
            </button>
            <button
              type="button"
              onClick={() => setStatus({ kind: "offer" })}
              className="pixel-font text-[10px] px-2 py-1.5 text-ink-soft hover:text-ink underline"
            >
              RETRY
            </button>
          </div>
        )}
      </div>

      {showExplainer && (
        <div
          className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShowExplainer(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="hooksetup-explainer-title"
            className="dialog-box w-[min(92vw,520px)]"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: "dialogIn 180ms ease" }}
          >
            <div className="flex items-center justify-between mb-3">
              <h2
                id="hooksetup-explainer-title"
                className="pixel-font text-[13px] text-accent"
              >
                ◆ WHAT AGENT FORCE HQ INSTALLS
              </h2>
              <button
                type="button"
                aria-label="Close dialog"
                onClick={() => setShowExplainer(false)}
                className="pixel-font text-[9px] text-ink-soft hover:text-ink underline"
              >
                [CLOSE]
              </button>
            </div>
            <ul className="text-[13px] leading-relaxed list-disc pl-5 space-y-2">
              <li>
                Everything stays on your machine. Each hook POSTs to{" "}
                <code className="text-[12px] px-1 bg-paper-dim border border-ink rounded">
                  http://127.0.0.1:47329
                </code>{" "}
                — loopback only. No outbound network traffic.
              </li>
              <li>
                Adds the hook entries Agent Force HQ needs to{" "}
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
