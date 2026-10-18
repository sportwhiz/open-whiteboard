import { describe, expect, it } from "vitest";
import { topmostObject } from "./canvas-hit-test";

describe("picking the object under the pointer", () => {
  it("takes the topmost hit, not the bottom-most", () => {
    const lane = { id: "lane", flavour: "affine:surface" };
    const note = { id: "note", flavour: "affine:note" };
    expect(topmostObject([lane, note])).toBe(note);
  });
  it("treats frames as canvas", () => {
    const frame = { id: "f", flavour: "affine:frame" };
    const shape = { id: "s", type: "shape" };
    expect(topmostObject([shape, frame])).toBe(shape);
    expect(topmostObject([frame])).toBeNull();
    expect(topmostObject([])).toBeNull();
  });
});
