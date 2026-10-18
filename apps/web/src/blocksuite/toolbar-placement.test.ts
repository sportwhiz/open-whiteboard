import { describe, expect, it } from "vitest";
import { balancedRowWidth, placeToolbar } from "./toolbar-placement";

const bounds = { x: 8, y: 8, w: 1424, h: 884 };
const size = { w: 560, h: 48 };

describe("contextual toolbar placement", () => {
  it("sits centred above the selection, clear of its handles", () => {
    const target = { x: 600, y: 400, w: 200, h: 200 };
    const placement = placeToolbar({ target, size, bounds, gap: 12, handleClearance: 18 });
    expect(placement.side).toBe("above");
    expect(placement.y + size.h).toBe(400 - 12 - 18);
    expect(placement.x + size.w / 2).toBe(700);
  });
  it("goes below when menus would not fit above", () => {
    const target = { x: 600, y: 100, w: 200, h: 200 };
    const placement = placeToolbar({ target, size, bounds, gap: 12, menuRoom: 56 });
    expect(placement.side).toBe("below");
    expect(placement.y).toBe(312);
  });
  it("shifts sideways to keep a frame title visible", () => {
    const target = { x: 300, y: 300, w: 140, h: 140 };
    const title = { x: 100, y: 230, w: 140, h: 24 };
    const placement = placeToolbar({ target, size, bounds, gap: 12, obstacles: [title] });
    expect(placement.side).toBe("above");
    expect(placement.x).toBeGreaterThanOrEqual(title.x + title.w);
    expect(placement.x).toBeLessThan(target.x + target.w);
  });
  it("avoids floating chrome by switching sides", () => {
    const target = { x: 40, y: 150, w: 200, h: 200 };
    const header = { x: 16, y: 16, w: 600, h: 120 };
    const placement = placeToolbar({ target, size, bounds, gap: 12, obstacles: [header] });
    expect(placement.side).toBe("below");
  });
  it("stays inside the canvas horizontally", () => {
    const placement = placeToolbar({ target: { x: 1350, y: 400, w: 80, h: 80 }, size, bounds });
    expect(placement.x + size.w).toBeLessThanOrEqual(bounds.x + bounds.w);
    expect(placeToolbar({ target: { x: 0, y: 400, w: 80, h: 80 }, size, bounds }).x).toBe(bounds.x);
  });
  it("pins inside the top of a selection that fills the view", () => {
    const placement = placeToolbar({ target: { x: -100, y: -50, w: 1700, h: 1100 }, size, bounds, gap: 12 });
    expect(placement.side).toBe("inside");
    expect(placement.y).toBe(bounds.y);
  });
  it("prefers a side that keeps nearby objects visible", () => {
    const target = { x: 600, y: 400, w: 200, h: 4 };
    const above = { x: 560, y: 320, w: 220, h: 70 };
    const placement = placeToolbar({ target, size, bounds, gap: 12, softObstacles: [above] });
    const clear = placement.x >= above.x + above.w || placement.x + size.w <= above.x ||
      placement.y >= above.y + above.h || placement.y + size.h <= above.y;
    expect(clear).toBe(true);
    // A wide neighbour above leaves only the side below.
    expect(placeToolbar({ target, size, bounds, gap: 12, softObstacles: [{ x: 0, y: 320, w: 1440, h: 70 }] }).side).toBe("below");
  });
  it("still sits beside the selection when every side has neighbours", () => {
    const target = { x: 600, y: 400, w: 200, h: 100 };
    const near = [{ x: 0, y: 300, w: 1440, h: 90 }, { x: 0, y: 510, w: 1440, h: 90 }];
    const placement = placeToolbar({ target, size, bounds, gap: 12, softObstacles: near });
    expect(["above", "below"]).toContain(placement.side);
  });
});

describe("balanced phone toolbar rows", () => {
  it("leaves a toolbar that fits on one row alone", () => {
    expect(balancedRowWidth([34, 34, 34], 6, 300)).toBeNull();
  });
  it("splits twelve buttons into two rows of six, not nine and three", () => {
    const width = balancedRowWidth(Array(12).fill(34), 6, 356)!;
    expect(width).toBeGreaterThanOrEqual(6 * 34 + 5 * 6);
    expect(width).toBeLessThan(7 * 34 + 6 * 6);
  });
  it("never needs more rows than the available width allows", () => {
    const widths = [80, 34, 34, 34, 34, 34, 34, 34, 34, 34, 34];
    const width = balancedRowWidth(widths, 6, 356)!;
    expect(width).toBeLessThanOrEqual(356);
    expect(width).toBeGreaterThanOrEqual(80);
  });
});
