import { describe, expect, it } from "vitest";
import { isZoomAt, steppedZoom, zoomCommandForKey, ZOOM_PRESETS, ZOOM_STEPS } from "./canvas-zoom";

const key = (init: Partial<KeyboardEvent>) => ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init });

describe("canvas zoom steps", () => {
  it("steps from odd fitted values onto recognisable levels", () => {
    expect(steppedZoom(0.59, 1)).toBe(0.67);
    expect(steppedZoom(0.59, -1)).toBe(0.5);
    expect(steppedZoom(0.84, 1)).toBe(1);
    expect(steppedZoom(1.04, -1)).toBe(1);
  });
  it("never makes a visible no-op step", () => {
    expect(steppedZoom(0.66, 1)).toBe(0.75);
    expect(steppedZoom(0.68, -1)).toBe(0.5);
    expect(steppedZoom(1.04, -1)).toBe(1);
  });
  it("moves off a step instead of staying on it", () => {
    expect(steppedZoom(1, 1)).toBe(1.25);
    expect(steppedZoom(1, -1)).toBe(0.75);
    expect(steppedZoom(1.0001, 1)).toBe(1.25);
  });
  it("clamps at the ends", () => {
    expect(steppedZoom(6, 1)).toBe(6);
    expect(steppedZoom(0.1, -1)).toBe(0.1);
  });
  it("can reach every preset by stepping from 100%", () => {
    for (const preset of ZOOM_PRESETS) expect(ZOOM_STEPS).toContain(preset);
    let zoom = 1;
    while (zoom > 0.25) zoom = steppedZoom(zoom, -1);
    expect(isZoomAt(zoom, 0.25)).toBe(true);
  });
  it("recognises presets despite float drift", () => {
    expect(isZoomAt(0.5000001, 0.5)).toBe(true);
    expect(isZoomAt(0.59, 0.5)).toBe(false);
  });
});

describe("zoom shortcuts", () => {
  it("maps command shortcuts per platform", () => {
    expect(zoomCommandForKey(key({ key: "=", code: "Equal", metaKey: true }), true)).toBe("in");
    expect(zoomCommandForKey(key({ key: "+", code: "Equal", metaKey: true, shiftKey: true }), true)).toBe("in");
    expect(zoomCommandForKey(key({ key: "-", code: "Minus", ctrlKey: true }), false)).toBe("out");
    expect(zoomCommandForKey(key({ key: "0", code: "Digit0", metaKey: true }), true)).toBe("reset");
    expect(zoomCommandForKey(key({ key: "0", code: "Digit0", ctrlKey: true }), true)).toBeNull();
  });
  it("maps Shift+digit by physical key", () => {
    expect(zoomCommandForKey(key({ key: ")", code: "Digit0", shiftKey: true }), true)).toBe("reset");
    expect(zoomCommandForKey(key({ key: "!", code: "Digit1", shiftKey: true }), true)).toBe("fit");
    expect(zoomCommandForKey(key({ key: "@", code: "Digit2", shiftKey: true }), false)).toBe("selection");
    expect(zoomCommandForKey(key({ key: "1", code: "Digit1" }), true)).toBeNull();
    expect(zoomCommandForKey(key({ key: "¡", code: "Digit1", altKey: true }), true)).toBeNull();
  });
});
