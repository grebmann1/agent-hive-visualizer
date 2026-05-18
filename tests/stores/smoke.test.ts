import { describe, it, expect } from "vitest";
import { create } from "zustand";

describe("Zustand store", () => {
  it("creates and reads state", () => {
    const useStore = create<{ count: number }>()(() => ({ count: 0 }));
    expect(useStore.getState().count).toBe(0);
  });
});
