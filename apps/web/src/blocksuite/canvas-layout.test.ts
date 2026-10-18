import { describe, expect, it } from "vitest";
import { fitPaddingFromChrome, fitViewportData, unionBounds, visibleArea } from "./canvas-layout";

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe("fit padding from floating chrome", () => {
  it("reserves the header, rail and bottom bars on desktop", () => {
    const host = box(0, 0, 1440, 900);
    const chrome = [box(16, 16, 202, 72), box(898, 16, 1424, 72), box(16, 88, 176, 134), box(16, 232, 72, 732), box(16, 836, 102, 884), box(1141, 836, 1424, 884)];
    expect(fitPaddingFromChrome(host, chrome, 32)).toEqual([134 + 32, 32, 900 - 836 + 32, 72 + 32]);
  });
  it("reserves a side panel that overlays the canvas", () => {
    const padding = fitPaddingFromChrome(box(0, 0, 1280, 800), [box(905, 88, 1264, 784)], 32);
    expect(padding[1]).toBe(1280 - 905 + 32);
  });
  it("puts a phone's bottom tool rail in the bottom padding", () => {
    const padding = fitPaddingFromChrome(box(0, 0, 390, 844), [box(8, 12, 382, 62), box(8, 716, 382, 767), box(8, 784, 78, 828)], 12);
    expect(padding).toEqual([62 + 12, 12, 844 - 716 + 12, 12]);
  });
  it("ignores chrome outside the canvas", () => {
    expect(fitPaddingFromChrome(box(0, 0, 800, 600), [box(900, 0, 1200, 600)], 10)).toEqual([10, 10, 10, 10]);
  });
});

describe("fitting the viewport", () => {
  it("uses exactly the space inside the padding", () => {
    const fit = fitViewportData({ x: 0, y: 0, w: 2000, h: 800 }, { width: 390, height: 844 }, [74, 12, 140, 12]);
    expect(fit.zoom).toBeCloseTo(366 / 2000);
    expect(fit.centerX).toBeCloseTo(1000);
  });
  it("never zooms past 100% and centres within the padded area", () => {
    const fit = fitViewportData({ x: 0, y: 0, w: 200, h: 200 }, { width: 1000, height: 800 }, [100, 0, 0, 100]);
    expect(fit.zoom).toBe(1);
    expect(fit.centerX).toBe(100 - 50);
    expect(fit.centerY).toBe(100 - 50);
  });
  it("unions bounds", () => {
    expect(unionBounds([{ x: 0, y: 10, w: 10, h: 10 }, { x: -5, y: 0, w: 5, h: 5 }])).toEqual({ x: -5, y: 0, w: 15, h: 20 });
    expect(unionBounds([])).toBeNull();
  });
});

describe("visible model area", () => {
  // Zoom 0.5, view origin at model (100, 200).
  const viewport = { toModelCoord: (x: number, y: number): [number, number] => [100 + x / 0.5, 200 + y / 0.5] };
  it("covers the whole canvas without a panel", () => {
    expect(visibleArea({ width: 1000, height: 800 }, [], viewport)).toEqual({ x: 100, y: 200, width: 2000, height: 1600 });
  });
  it("excludes a side panel overlaying the right edge", () => {
    expect(visibleArea({ width: 1000, height: 800 }, [{ left: 640, width: 360, height: 700 }], viewport).width).toBe(1280);
    // A small popover on the right is not a panel.
    expect(visibleArea({ width: 1000, height: 800 }, [{ left: 640, width: 360, height: 100 }], viewport).width).toBe(2000);
  });
});
