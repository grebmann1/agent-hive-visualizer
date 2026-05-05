"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

// One xterm.js instance bound to one PTY terminalId. The store spawns the
// PTY; this component just wires up the UI: accepts keystrokes, renders
// stdout, reflows on container resize.

interface Props {
  terminalId: string;
  // Visible vs hidden — keep the xterm mounted but hide its wrapper so the
  // scrollback + cursor state survive across tab switches.
  active: boolean;
}

// Match the dark-studio palette from globals.css.
const STUDIO_THEME = {
  background: "#141827",
  foreground: "#d5d8ff",
  cursor: "#6ee7b7",
  cursorAccent: "#141827",
  selectionBackground: "rgba(110, 231, 183, 0.25)",
  black: "#1b1e2b",
  red: "#ef4444",
  green: "#6ee7b7",
  yellow: "#fbbf24",
  blue: "#7dd3fc",
  magenta: "#e0b3ff",
  cyan: "#67e8f9",
  white: "#d5d8ff",
  brightBlack: "#3a3e52",
  brightRed: "#fca5a5",
  brightGreen: "#a7f3d0",
  brightYellow: "#fde68a",
  brightBlue: "#bae6fd",
  brightMagenta: "#f0abfc",
  brightCyan: "#a5f3fc",
  brightWhite: "#ffffff",
};

export default function TerminalInstance({ terminalId, active }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const bridge = window.agentquest?.terminal;
    if (!bridge) return;

    const term = new Terminal({
      fontFamily:
        '"Menlo", "SFMono-Regular", "Consolas", "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: STUDIO_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);

    // Initial fit happens after Open when the host has a real size. Use
    // rAF so the style is settled.
    requestAnimationFrame(() => {
      try {
        fit.fit();
        const { cols, rows } = term;
        bridge.resize(terminalId, cols, rows);
      } catch {
        // ignore
      }
    });

    // Keystrokes → PTY.
    const dataDispose = term.onData((data) => {
      bridge.write(terminalId, data);
    });
    // PTY → terminal.
    const offData = bridge.onData(({ terminalId: id, data }) => {
      if (id !== terminalId) return;
      term.write(data);
    });
    // Host resize → fit → inform PTY.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        const { cols, rows } = term;
        bridge.resize(terminalId, cols, rows);
      } catch {
        // ignore
      }
    });
    ro.observe(host);

    termRef.current = term;
    fitRef.current = fit;

    return () => {
      dataDispose.dispose();
      offData();
      ro.disconnect();
      try {
        term.dispose();
      } catch {
        // ignore
      }
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId]);

  // When the tab becomes visible again, refit (size likely changed while hidden).
  useEffect(() => {
    if (!active) return;
    const t = termRef.current;
    const f = fitRef.current;
    if (!t || !f) return;
    const id = requestAnimationFrame(() => {
      try {
        f.fit();
        window.agentquest?.terminal?.resize(terminalId, t.cols, t.rows);
        t.focus();
      } catch {
        // ignore
      }
    });
    return () => cancelAnimationFrame(id);
  }, [active, terminalId]);

  // MainSplit fires this event on Cmd+` so whichever terminal is active
  // grabs keystrokes immediately.
  useEffect(() => {
    const onFocusRequest = () => {
      if (!active) return;
      try {
        termRef.current?.focus();
      } catch {
        // ignore
      }
    };
    window.addEventListener("agentquest:focus-terminal", onFocusRequest);
    return () =>
      window.removeEventListener("agentquest:focus-terminal", onFocusRequest);
  }, [active]);

  return (
    <div
      ref={hostRef}
      className="absolute inset-0"
      style={{
        display: active ? "block" : "none",
        background: STUDIO_THEME.background,
      }}
    />
  );
}
