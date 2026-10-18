import { describe, expect, it } from "vitest";
import { commentPinPoint } from "./CommentPins";

const toView = (x: number, y: number): [number, number] => [x * 2, y * 2];

describe("comment pin placement", () => {
  it("follows an attached object, outside its top-right resize handle", () => {
    const object = { x: 100, y: 50, w: 200, h: 200 };
    const point = commentPinPoint({ anchor: { x: 0, y: 0, objectId: "n" } }, toView, () => object);
    expect(point.attached).toBe(true);
    // The pin's tip is its bottom-left corner; its body grows up and right.
    // Engine corner handles reach about 6px past the corner.
    expect(point.x).toBeGreaterThanOrEqual(object.x + object.w + 8);
    expect(point.y).toBeLessThanOrEqual(object.y + 6);
  });
  it("stays at its canvas point when unattached or the object is gone", () => {
    expect(commentPinPoint({ anchor: { x: 10, y: 20, objectId: null } }, toView, () => null)).toEqual({ x: 20, y: 40, attached: false });
    expect(commentPinPoint({ anchor: { x: 10, y: 20, objectId: "gone" } }, toView, () => null).attached).toBe(false);
  });
});
