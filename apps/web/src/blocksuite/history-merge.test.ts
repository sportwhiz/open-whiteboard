import { describe, expect, it } from "vitest";
import { nudgeDelta, startsNewStep } from "./history-merge";

describe("nudge history", () => {
  it("merges rapid nudges of the same selection into one step", () => {
    expect(startsNewStep(null, 1000, "a")).toBe(true);
    expect(startsNewStep({ at: 1000, key: "a" }, 1300, "a")).toBe(false);
    expect(startsNewStep({ at: 1000, key: "a" }, 1600, "a")).toBe(true);
  });
  it("starts a new step for a different selection", () => {
    expect(startsNewStep({ at: 1000, key: "a" }, 1100, "b")).toBe(true);
  });
  it("maps arrows to 1px, or 10px with Shift", () => {
    expect(nudgeDelta("ArrowRight", false)).toEqual([1, 0]);
    expect(nudgeDelta("ArrowUp", true)).toEqual([0, -10]);
    expect(nudgeDelta("Enter", false)).toBeNull();
  });
});
