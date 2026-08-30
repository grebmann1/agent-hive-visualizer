import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "../../src/stores/useSettingsStore";

const initialState = {
  worldLifeV2: false,
  calmMode: false,
};

describe("useSettingsStore", () => {
  beforeEach(() => {
    useSettingsStore.setState(initialState);
  });

  describe("initial state", () => {
    it("worldLifeV2 defaults to false", () => {
      expect(useSettingsStore.getState().worldLifeV2).toBe(false);
    });

    it("calmMode defaults to false", () => {
      expect(useSettingsStore.getState().calmMode).toBe(false);
    });
  });

  describe("setWorldLifeV2", () => {
    it("sets worldLifeV2 to true", () => {
      useSettingsStore.getState().setWorldLifeV2(true);
      expect(useSettingsStore.getState().worldLifeV2).toBe(true);
    });

    it("sets worldLifeV2 to false", () => {
      useSettingsStore.setState({ worldLifeV2: true });
      useSettingsStore.getState().setWorldLifeV2(false);
      expect(useSettingsStore.getState().worldLifeV2).toBe(false);
    });
  });

  describe("toggleWorldLifeV2", () => {
    it("flips false to true and returns the new value", () => {
      const result = useSettingsStore.getState().toggleWorldLifeV2();
      expect(result).toBe(true);
      expect(useSettingsStore.getState().worldLifeV2).toBe(true);
    });

    it("flips true to false and returns the new value", () => {
      useSettingsStore.setState({ worldLifeV2: true });
      const result = useSettingsStore.getState().toggleWorldLifeV2();
      expect(result).toBe(false);
      expect(useSettingsStore.getState().worldLifeV2).toBe(false);
    });

    it("toggling twice returns to original state", () => {
      const original = useSettingsStore.getState().worldLifeV2;
      useSettingsStore.getState().toggleWorldLifeV2();
      useSettingsStore.getState().toggleWorldLifeV2();
      expect(useSettingsStore.getState().worldLifeV2).toBe(original);
    });
  });

  describe("setCalmMode", () => {
    it("sets calmMode to true", () => {
      useSettingsStore.getState().setCalmMode(true);
      expect(useSettingsStore.getState().calmMode).toBe(true);
    });

    it("sets calmMode to false", () => {
      useSettingsStore.setState({ calmMode: true });
      useSettingsStore.getState().setCalmMode(false);
      expect(useSettingsStore.getState().calmMode).toBe(false);
    });
  });

  describe("toggleCalmMode", () => {
    it("flips false to true and returns the new value", () => {
      const result = useSettingsStore.getState().toggleCalmMode();
      expect(result).toBe(true);
      expect(useSettingsStore.getState().calmMode).toBe(true);
    });

    it("flips true to false and returns the new value", () => {
      useSettingsStore.setState({ calmMode: true });
      const result = useSettingsStore.getState().toggleCalmMode();
      expect(result).toBe(false);
      expect(useSettingsStore.getState().calmMode).toBe(false);
    });

    it("toggling twice returns to original state", () => {
      const original = useSettingsStore.getState().calmMode;
      useSettingsStore.getState().toggleCalmMode();
      useSettingsStore.getState().toggleCalmMode();
      expect(useSettingsStore.getState().calmMode).toBe(original);
    });
  });

});
