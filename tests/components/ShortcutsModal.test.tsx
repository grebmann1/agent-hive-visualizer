import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ShortcutsModal from "../../src/components/ShortcutsModal";
import { useGameStore } from "../../src/stores/useGameStore";

describe("ShortcutsModal", () => {
  beforeEach(() => {
    // Reset the game store so dialog is inactive
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
  });

  it("does not render when closed (initial state)", () => {
    const { container } = render(<ShortcutsModal />);
    expect(container.innerHTML).toBe("");
  });

  it("renders when opened via ? key", () => {
    render(<ShortcutsModal />);
    // Press "?" to open the modal
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByText("◆ KEYBOARD SHORTCUTS"),
    ).toBeInTheDocument();
  });

  it("close button click closes the modal", () => {
    render(<ShortcutsModal />);
    // Open first
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Click the close button
    const closeBtn = screen.getByLabelText("Close dialog");
    fireEvent.click(closeBtn);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Escape key closes the modal", () => {
    render(<ShortcutsModal />);
    // Open first
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Press Escape to close
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not open when dialog is active", () => {
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
    const { container } = render(<ShortcutsModal />);
    fireEvent.keyDown(window, { key: "?" });
    expect(container.innerHTML).toBe("");
  });
});
