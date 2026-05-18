import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import Intro from "../../src/components/Intro";
import { useNpcStore } from "../../src/stores/useNpcStore";

const DISMISSED_KEY = "agentquest_intro_seen_v4";

describe("Intro", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset dynamic NPCs to empty
    useNpcStore.setState({ dynamic: {} });
  });

  it("renders on first visit (no localStorage dismissal)", async () => {
    render(<Intro />);
    await waitFor(() => {
      expect(
        screen.getByText("◆ WELCOME TO AGENT FORCE HQ"),
      ).toBeInTheDocument();
    });
  });

  it("dismiss stores to localStorage and hides", async () => {
    render(<Intro />);
    await waitFor(() => {
      expect(
        screen.getByText("◆ WELCOME TO AGENT FORCE HQ"),
      ).toBeInTheDocument();
    });

    // Click the dismiss button (the x)
    const dismissBtn = screen.getByLabelText("Dismiss welcome");
    fireEvent.click(dismissBtn);

    // Should hide
    expect(
      screen.queryByText("◆ WELCOME TO AGENT FORCE HQ"),
    ).not.toBeInTheDocument();

    // Should set localStorage
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("1");
  });

  it("does not render if already dismissed", () => {
    localStorage.setItem(DISMISSED_KEY, "1");
    const { container } = render(<Intro />);
    expect(container.innerHTML).toBe("");
  });

  it("auto-dismisses when a dynamic agent appears", async () => {
    const { rerender } = render(<Intro />);
    await waitFor(() => {
      expect(
        screen.getByText("◆ WELCOME TO AGENT FORCE HQ"),
      ).toBeInTheDocument();
    });

    // Simulate a dynamic agent joining
    useNpcStore.setState({
      dynamic: {
        "claude-123": {
          dynamic: true,
          id: "claude-123",
          name: "Test Agent",
          role: "Claude Agent",
          homeRoom: "desk",
          col: 10,
          row: 10,
          greeting: "Hello",
          systemPrompt: "",
          toolBox: [],
        } as any,
      },
    });

    rerender(<Intro />);

    await waitFor(() => {
      expect(
        screen.queryByText("◆ WELCOME TO AGENT FORCE HQ"),
      ).not.toBeInTheDocument();
    });
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("1");
  });
});
