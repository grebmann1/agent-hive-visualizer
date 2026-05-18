import { describe, it, expect, beforeEach } from "vitest";
import { useGameStore } from "../../src/stores/useGameStore";
import type { NpcDef } from "../../src/game/npcs";
import type { DialogState } from "../../src/stores/useGameStore";

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
  id: "agent-1",
  name: "Test Agent",
  role: "developer",
  homeRoom: "desk",
  col: 5,
  row: 5,
  tint: {},
  greeting: "Hello, I am Test Agent!",
  systemPrompt: "You are a helpful test agent.",
  toolBox: ["Read", "Edit"],
};

describe("useGameStore", () => {
  beforeEach(() => {
    useGameStore.setState({
      followNpcId: null,
      dialog: { ...closedDialog },
      dialogHistoryByNpc: {},
    });
  });

  describe("initial state", () => {
    it("followNpcId is null", () => {
      expect(useGameStore.getState().followNpcId).toBeNull();
    });

    it("dialog is inactive", () => {
      const { dialog } = useGameStore.getState();
      expect(dialog.active).toBe(false);
      expect(dialog.npcId).toBeNull();
      expect(dialog.queue).toEqual([]);
      expect(dialog.awaitingInput).toBe(false);
      expect(dialog.isThinking).toBe(false);
      expect(dialog.streamingLineId).toBeNull();
      expect(dialog.toolStatus).toBeNull();
    });

    it("dialogHistoryByNpc is empty", () => {
      expect(useGameStore.getState().dialogHistoryByNpc).toEqual({});
    });
  });

  describe("setFollowNpc", () => {
    it("sets followNpcId to a given id", () => {
      useGameStore.getState().setFollowNpc("agent-1");
      expect(useGameStore.getState().followNpcId).toBe("agent-1");
    });

    it("clears followNpcId when set to null", () => {
      useGameStore.getState().setFollowNpc("agent-1");
      useGameStore.getState().setFollowNpc(null);
      expect(useGameStore.getState().followNpcId).toBeNull();
    });

    it("is idempotent — setting same id twice keeps same value", () => {
      useGameStore.getState().setFollowNpc("agent-1");
      useGameStore.getState().setFollowNpc("agent-1");
      expect(useGameStore.getState().followNpcId).toBe("agent-1");
    });
  });

  describe("openDialog", () => {
    it("activates the dialog with the NPC greeting", () => {
      useGameStore.getState().openDialog(mockNpc);
      const { dialog } = useGameStore.getState();
      expect(dialog.active).toBe(true);
      expect(dialog.npcId).toBe("agent-1");
      expect(dialog.queue).toHaveLength(1);
      expect(dialog.queue[0].source).toBe("npc");
      expect(dialog.queue[0].speaker).toBe("Test Agent");
      expect(dialog.queue[0].text).toBe("Hello, I am Test Agent!");
    });

    it("uses greetingOverride when provided", () => {
      useGameStore.getState().openDialog(mockNpc, "Custom greeting!");
      const { dialog } = useGameStore.getState();
      expect(dialog.queue[0].text).toBe("Custom greeting!");
    });

    it("resets dialog state fields on open", () => {
      // Pre-dirty the dialog state
      useGameStore.setState({
        dialog: {
          ...closedDialog,
          awaitingInput: true,
          isThinking: true,
          toolStatus: "Reading file...",
        },
      });
      useGameStore.getState().openDialog(mockNpc);
      const { dialog } = useGameStore.getState();
      expect(dialog.awaitingInput).toBe(false);
      expect(dialog.isThinking).toBe(false);
      expect(dialog.streamingLineId).toBeNull();
      expect(dialog.toolStatus).toBeNull();
    });
  });

  describe("closeDialog", () => {
    it("deactivates the dialog and clears all fields", () => {
      useGameStore.getState().openDialog(mockNpc);
      useGameStore.getState().closeDialog();
      const { dialog } = useGameStore.getState();
      expect(dialog.active).toBe(false);
      expect(dialog.npcId).toBeNull();
      expect(dialog.queue).toEqual([]);
      expect(dialog.awaitingInput).toBe(false);
      expect(dialog.isThinking).toBe(false);
      expect(dialog.streamingLineId).toBeNull();
      expect(dialog.toolStatus).toBeNull();
    });

    it("is idempotent — closing an already-closed dialog is safe", () => {
      useGameStore.getState().closeDialog();
      const { dialog } = useGameStore.getState();
      expect(dialog.active).toBe(false);
    });
  });

  describe("enqueueLine", () => {
    it("adds a line to the dialog queue and returns its id", () => {
      useGameStore.getState().openDialog(mockNpc);
      const id = useGameStore.getState().enqueueLine({
        source: "player",
        text: "What are you working on?",
      });
      expect(id).toMatch(/^line-/);
      const { dialog } = useGameStore.getState();
      // One from open, one from enqueue
      expect(dialog.queue).toHaveLength(2);
      expect(dialog.queue[1].text).toBe("What are you working on?");
      expect(dialog.queue[1].source).toBe("player");
    });
  });

  describe("shiftLine", () => {
    it("removes the first line from the queue", () => {
      useGameStore.getState().openDialog(mockNpc);
      useGameStore.getState().enqueueLine({
        source: "npc",
        speaker: "Test Agent",
        text: "Second line",
      });
      const queueBefore = useGameStore.getState().dialog.queue;
      expect(queueBefore).toHaveLength(2);

      useGameStore.getState().shiftLine();
      const queueAfter = useGameStore.getState().dialog.queue;
      expect(queueAfter).toHaveLength(1);
      expect(queueAfter[0].text).toBe("Second line");
    });

    it("results in empty queue when shifting last line", () => {
      useGameStore.getState().openDialog(mockNpc);
      useGameStore.getState().shiftLine();
      expect(useGameStore.getState().dialog.queue).toHaveLength(0);
    });
  });

  describe("setAwaitingInput", () => {
    it("sets awaitingInput to true", () => {
      useGameStore.getState().setAwaitingInput(true);
      expect(useGameStore.getState().dialog.awaitingInput).toBe(true);
    });

    it("sets awaitingInput to false", () => {
      useGameStore.getState().setAwaitingInput(true);
      useGameStore.getState().setAwaitingInput(false);
      expect(useGameStore.getState().dialog.awaitingInput).toBe(false);
    });
  });

  describe("setThinking", () => {
    it("sets isThinking to true", () => {
      useGameStore.getState().setThinking(true);
      expect(useGameStore.getState().dialog.isThinking).toBe(true);
    });

    it("sets isThinking to false", () => {
      useGameStore.getState().setThinking(true);
      useGameStore.getState().setThinking(false);
      expect(useGameStore.getState().dialog.isThinking).toBe(false);
    });
  });

  describe("streaming line helpers", () => {
    it("startStreamingLine adds a line and sets streamingLineId", () => {
      const id = useGameStore.getState().startStreamingLine({
        source: "npc",
        speaker: "Test Agent",
        text: "I am ",
      });
      const { dialog } = useGameStore.getState();
      expect(dialog.streamingLineId).toBe(id);
      expect(dialog.queue).toHaveLength(1);
      expect(dialog.queue[0].text).toBe("I am ");
    });

    it("appendToStreamingLine appends text to the streaming line", () => {
      useGameStore.getState().startStreamingLine({
        source: "npc",
        speaker: "Test Agent",
        text: "Hello ",
      });
      useGameStore.getState().appendToStreamingLine("world");
      const { dialog } = useGameStore.getState();
      expect(dialog.queue[0].text).toBe("Hello world");
    });

    it("appendToStreamingLine is no-op when there is no active streaming line", () => {
      useGameStore.getState().appendToStreamingLine("orphan text");
      const { dialog } = useGameStore.getState();
      expect(dialog.queue).toHaveLength(0);
    });

    it("finishStreamingLine clears streamingLineId and toolStatus", () => {
      useGameStore.getState().startStreamingLine({
        source: "npc",
        speaker: "Test Agent",
        text: "Done",
      });
      useGameStore.getState().setToolStatus("Reading file...");
      useGameStore.getState().finishStreamingLine();
      const { dialog } = useGameStore.getState();
      expect(dialog.streamingLineId).toBeNull();
      expect(dialog.toolStatus).toBeNull();
    });
  });

  describe("setToolStatus", () => {
    it("sets toolStatus", () => {
      useGameStore.getState().setToolStatus("Running tests...");
      expect(useGameStore.getState().dialog.toolStatus).toBe("Running tests...");
    });

    it("clears toolStatus when set to null", () => {
      useGameStore.getState().setToolStatus("Running tests...");
      useGameStore.getState().setToolStatus(null);
      expect(useGameStore.getState().dialog.toolStatus).toBeNull();
    });
  });

  describe("appendDialogTurn", () => {
    it("appends a turn to the specified NPC history", () => {
      useGameStore.getState().appendDialogTurn("agent-1", {
        role: "user",
        content: "Hi there",
      });
      const history = useGameStore.getState().dialogHistoryByNpc["agent-1"];
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual({ role: "user", content: "Hi there" });
    });

    it("accumulates multiple turns", () => {
      useGameStore.getState().appendDialogTurn("agent-1", {
        role: "user",
        content: "Q1",
      });
      useGameStore.getState().appendDialogTurn("agent-1", {
        role: "assistant",
        content: "A1",
      });
      const history = useGameStore.getState().dialogHistoryByNpc["agent-1"];
      expect(history).toHaveLength(2);
    });

    it("caps history at 20 turns", () => {
      for (let i = 0; i < 25; i++) {
        useGameStore.getState().appendDialogTurn("agent-1", {
          role: i % 2 === 0 ? "user" : "assistant",
          content: `turn-${i}`,
        });
      }
      const history = useGameStore.getState().dialogHistoryByNpc["agent-1"];
      expect(history).toHaveLength(20);
      // Should keep the most recent 20
      expect(history[0].content).toBe("turn-5");
      expect(history[19].content).toBe("turn-24");
    });

    it("keeps separate histories per NPC", () => {
      useGameStore.getState().appendDialogTurn("agent-1", {
        role: "user",
        content: "Hi Agent 1",
      });
      useGameStore.getState().appendDialogTurn("agent-2", {
        role: "user",
        content: "Hi Agent 2",
      });
      expect(
        useGameStore.getState().dialogHistoryByNpc["agent-1"],
      ).toHaveLength(1);
      expect(
        useGameStore.getState().dialogHistoryByNpc["agent-2"],
      ).toHaveLength(1);
    });
  });
});
