import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useGameStore } from "../../src/stores/useGameStore";
import { useSettingsStore } from "../../src/stores/useSettingsStore";

// Mock DebugPanel — it may pull in heavy deps
vi.mock("../../src/components/DebugPanel", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="debug-panel">Debug Panel</div> : null,
}));

// Mock agentLog
vi.mock("../../src/game/agentLog", () => ({
  isEnabled: () => false,
}));

// Import HudOverlay after mocks are set up
import HudOverlay from "../../src/components/HudOverlay";

describe("HudOverlay", () => {
  beforeEach(() => {
    // Ensure dialog is inactive so buttons are visible
    useGameStore.setState({
      dialog: {
        active: false,
        npcId: null,
        queue: [],
        awaitingInput: false,
        isThinking: false,
        streamingLineId: null,
        toolStatus: null,
      },
    });
    // Reset calm mode to false
    useSettingsStore.setState({ calmMode: false });
  });

  it("renders control buttons when dialog is not active", () => {
    render(<HudOverlay />);
    expect(screen.getByLabelText("Enable calm mode")).toBeInTheDocument();
    expect(screen.getByLabelText("Open debug tools")).toBeInTheDocument();
  });

  it("does not render control buttons when dialog is active", () => {
    useGameStore.setState({
      dialog: {
        active: true,
        npcId: "test",
        queue: [],
        awaitingInput: false,
        isThinking: false,
        streamingLineId: null,
        toolStatus: null,
      },
    });
    render(<HudOverlay />);
    expect(
      screen.queryByLabelText("Enable calm mode"),
    ).not.toBeInTheDocument();
  });

  it("calm mode toggle shows aria-pressed=false when calm mode is off", () => {
    useSettingsStore.setState({ calmMode: false });
    render(<HudOverlay />);
    const btn = screen.getByLabelText("Enable calm mode");
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it("calm mode toggle shows aria-pressed=true when calm mode is on", () => {
    useSettingsStore.setState({ calmMode: true });
    render(<HudOverlay />);
    const btn = screen.getByLabelText("Calm mode active");
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  it("clicking calm mode toggle changes settings store", () => {
    useSettingsStore.setState({ calmMode: false });
    render(<HudOverlay />);
    const btn = screen.getByLabelText("Enable calm mode");
    fireEvent.click(btn);
    expect(useSettingsStore.getState().calmMode).toBe(true);
  });

  it("clicking calm mode toggle again reverts to off", () => {
    useSettingsStore.setState({ calmMode: true });
    render(<HudOverlay />);
    const btn = screen.getByLabelText("Calm mode active");
    fireEvent.click(btn);
    expect(useSettingsStore.getState().calmMode).toBe(false);
  });
});
