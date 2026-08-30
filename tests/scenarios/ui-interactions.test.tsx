import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { useGameStore } from "../../src/stores/useGameStore";
import { useToastStore } from "../../src/stores/useToastStore";
import type { NpcDef } from "../../src/game/npcs";
import type { DialogState } from "../../src/stores/useGameStore";
import ShortcutsModal from "../../src/components/ShortcutsModal";
import HookSetupBanner from "../../src/components/HookSetupBanner";

const closedDialog: DialogState = {
  active: false,
  npcId: null,
  queue: [],
  awaitingInput: false,
  isThinking: false,
  streamingLineId: null,
  toolStatus: null,
};

const mockNpc: NpcDef = {
  id: "test-npc-1",
  name: "Test NPC",
  role: "tester",
  homeRoom: "desk",
  col: 3,
  row: 3,
  tint: {},
  greeting: "Hello traveler!",
  systemPrompt: "You are a test NPC.",
  toolBox: ["Read"],
};

// ---------------------------------------------------------------------------
// Scenario 4: Click NPC -> dialog opens -> close dialog
// ---------------------------------------------------------------------------
describe("Scenario 4: Click NPC → dialog opens → close dialog", () => {
  beforeEach(() => {
    useGameStore.setState({
      followNpcId: null,
      dialog: { ...closedDialog },
      dialogHistoryByNpc: {},
    });
  });

  it("starts with dialog closed", () => {
    expect(useGameStore.getState().dialog.active).toBe(false);
  });

  it("openDialog activates and sets npcId", () => {
    useGameStore.getState().openDialog(mockNpc);
    const { dialog } = useGameStore.getState();
    expect(dialog.active).toBe(true);
    expect(dialog.npcId).toBe("test-npc-1");
  });

  it("closeDialog deactivates the dialog", () => {
    useGameStore.getState().openDialog(mockNpc);
    useGameStore.getState().closeDialog();
    const { dialog } = useGameStore.getState();
    expect(dialog.active).toBe(false);
  });

  it("closeDialog is idempotent — calling twice does not throw", () => {
    useGameStore.getState().openDialog(mockNpc);
    useGameStore.getState().closeDialog();
    // Second call should not throw
    expect(() => useGameStore.getState().closeDialog()).not.toThrow();
    expect(useGameStore.getState().dialog.active).toBe(false);
  });

  it("full lifecycle: closed → open → verify → close → verify", () => {
    // Initially closed
    expect(useGameStore.getState().dialog.active).toBe(false);

    // Open with mock NPC
    useGameStore.getState().openDialog(mockNpc);
    const afterOpen = useGameStore.getState().dialog;
    expect(afterOpen.active).toBe(true);
    expect(afterOpen.npcId).toBe("test-npc-1");
    expect(afterOpen.queue).toHaveLength(1);
    expect(afterOpen.queue[0].text).toBe("Hello traveler!");
    expect(afterOpen.queue[0].speaker).toBe("Test NPC");

    // Close dialog
    useGameStore.getState().closeDialog();
    const afterClose = useGameStore.getState().dialog;
    expect(afterClose.active).toBe(false);
    expect(afterClose.npcId).toBeNull();
    expect(afterClose.queue).toHaveLength(0);

    // Idempotent close
    expect(() => useGameStore.getState().closeDialog()).not.toThrow();
    expect(useGameStore.getState().dialog.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Hook install flow: banner → install → success toast → hides
// ---------------------------------------------------------------------------
describe("Scenario 6: Hook install flow: banner → install → success toast → hides", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as any).agentquest;
    // Reset toast store
    useToastStore.setState({ message: null, tone: "info" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("full onboarding: banner appears → click install → banner hides → toast shown", async () => {
    const installMock = vi.fn().mockResolvedValue({ ok: true });

    (window as any).agentquest = {
      hooks: {
        isInstalled: vi.fn().mockResolvedValue({ installed: false }),
        install: installMock,
        openSettings: vi.fn(),
      },
    };

    render(<HookSetupBanner />);

    // Wait for the banner to appear
    await waitFor(() => {
      expect(screen.getByText("INSTALL HOOKS")).toBeInTheDocument();
    });

    // Click the install button
    await act(async () => {
      fireEvent.click(screen.getByText("INSTALL HOOKS"));
    });

    // Verify install was called
    expect(installMock).toHaveBeenCalledTimes(1);

    // Verify the banner disappears after successful install
    await waitFor(() => {
      expect(screen.queryByText("INSTALL HOOKS")).not.toBeInTheDocument();
    });

    // Verify the toast was shown
    const toastState = useToastStore.getState();
    expect(toastState.message).toBe(
      "Hooks installed — live agent events are on.",
    );
    expect(toastState.tone).toBe("info");
  });

  it("banner shows 'NOT CONNECTED' status before install", async () => {
    (window as any).agentquest = {
      hooks: {
        isInstalled: vi.fn().mockResolvedValue({ installed: false }),
        install: vi.fn().mockResolvedValue({ ok: true }),
        openSettings: vi.fn(),
      },
    };

    render(<HookSetupBanner />);

    await waitFor(() => {
      expect(screen.getByText("NOT CONNECTED")).toBeInTheDocument();
    });
    expect(screen.getByText("INSTALL HOOKS")).toBeInTheDocument();
  });

  it("shows error state when install fails", async () => {
    (window as any).agentquest = {
      hooks: {
        isInstalled: vi.fn().mockResolvedValue({ installed: false }),
        install: vi.fn().mockResolvedValue({ ok: false, error: "Permission denied" }),
        openSettings: vi.fn(),
      },
    };

    render(<HookSetupBanner />);

    await waitFor(() => {
      expect(screen.getByText("INSTALL HOOKS")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("INSTALL HOOKS"));
    });

    await waitFor(() => {
      expect(screen.getByText("Permission denied")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: Keyboard shortcuts: ? opens modal, Escape closes
// ---------------------------------------------------------------------------
describe("Scenario 10: Keyboard shortcuts: ? opens modal, Escape closes", () => {
  beforeEach(() => {
    useGameStore.setState({
      dialog: { ...closedDialog },
    });
  });

  it("modal is NOT visible initially", () => {
    const { container } = render(<ShortcutsModal />);
    expect(container.innerHTML).toBe("");
  });

  it("? key opens the modal", () => {
    render(<ShortcutsModal />);
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("◆ KEYBOARD SHORTCUTS")).toBeInTheDocument();
  });

  it("Escape closes the modal", () => {
    render(<ShortcutsModal />);
    // Open
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Close
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("full cycle: closed → ? opens → Escape closes → hidden", () => {
    const { container } = render(<ShortcutsModal />);

    // Initially not visible
    expect(container.innerHTML).toBe("");

    // Press ? to open
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("◆ KEYBOARD SHORTCUTS")).toBeInTheDocument();

    // Press Escape to close
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(container.innerHTML).toBe("");
  });

  it("? does NOT open modal when dialog is active", () => {
    // Set dialog active
    useGameStore.setState({
      dialog: {
        active: true,
        npcId: "some-agent",
        queue: [],
        awaitingInput: false,
        isThinking: false,
        streamingLineId: null,
        toolStatus: null,
      },
    });

    const { container } = render(<ShortcutsModal />);

    // Press ? — should NOT open
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(container.innerHTML).toBe("");
  });

  it("? toggles the modal (second press closes it)", () => {
    render(<ShortcutsModal />);

    // First press: open
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Second press: close (toggle behavior)
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
