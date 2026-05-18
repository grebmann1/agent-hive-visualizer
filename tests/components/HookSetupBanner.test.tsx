import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import HookSetupBanner from "../../src/components/HookSetupBanner";

const DISMISS_KEY = "agentquest:hooksBannerDismissedAt";

describe("HookSetupBanner", () => {
  beforeEach(() => {
    localStorage.clear();
    // Clean up window.agentquest between tests
    delete (window as any).agentquest;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when hooks bridge is absent (window.agentquest undefined)", async () => {
    const { container } = render(<HookSetupBanner />);
    // Component starts in "loading" state which also returns null,
    // then transitions to "hidden" since bridge is absent.
    await waitFor(() => {
      expect(container.innerHTML).toBe("");
    });
  });

  it("shows the banner with INSTALL HOOKS button when hooks are not installed", async () => {
    (window as any).agentquest = {
      hooks: {
        isInstalled: vi.fn().mockResolvedValue({ installed: false }),
        install: vi.fn().mockResolvedValue({ ok: true }),
        openSettings: vi.fn(),
      },
    };

    render(<HookSetupBanner />);

    await waitFor(() => {
      expect(screen.getByText("INSTALL HOOKS")).toBeInTheDocument();
    });
    expect(screen.getByText("NOT CONNECTED")).toBeInTheDocument();
  });

  it("renders nothing when hooks are already installed", async () => {
    (window as any).agentquest = {
      hooks: {
        isInstalled: vi.fn().mockResolvedValue({ installed: true }),
        install: vi.fn(),
        openSettings: vi.fn(),
      },
    };

    const { container } = render(<HookSetupBanner />);

    await waitFor(() => {
      expect(container.innerHTML).toBe("");
    });
  });

  it("dismiss button sets localStorage and hides the banner", async () => {
    (window as any).agentquest = {
      hooks: {
        isInstalled: vi.fn().mockResolvedValue({ installed: false }),
        install: vi.fn(),
        openSettings: vi.fn(),
      },
    };

    render(<HookSetupBanner />);

    await waitFor(() => {
      expect(screen.getByText("INSTALL HOOKS")).toBeInTheDocument();
    });

    // Click the LATER (dismiss) button
    const laterBtn = screen.getByText("LATER");
    act(() => {
      laterBtn.click();
    });

    // Should hide
    expect(screen.queryByText("INSTALL HOOKS")).not.toBeInTheDocument();

    // Should set localStorage
    const stored = localStorage.getItem(DISMISS_KEY);
    expect(stored).not.toBeNull();
    expect(Number(stored)).toBeGreaterThan(0);
  });

  it("does not show banner if dismissed recently (within 24h)", async () => {
    // Set dismissal timestamp to recent
    localStorage.setItem(DISMISS_KEY, String(Date.now()));

    (window as any).agentquest = {
      hooks: {
        isInstalled: vi.fn().mockResolvedValue({ installed: false }),
        install: vi.fn(),
        openSettings: vi.fn(),
      },
    };

    const { container } = render(<HookSetupBanner />);

    await waitFor(() => {
      expect(container.innerHTML).toBe("");
    });
  });
});
