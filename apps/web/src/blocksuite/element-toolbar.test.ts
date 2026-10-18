import { describe, expect, it } from "vitest";
import { displayColor, elementToolbarKind, frameFitBounds, sameColor, shapeChoice, shapeTypePatch } from "./element-toolbar";

const item = (kind: string, simpleSticky = false) => ({ kind, simpleSticky });

describe("which toolbar a selection gets", () => {
  it("gives each covered object type its own toolbar", () => {
    for (const kind of ["shape", "connector", "text", "image", "frame", "group"]) expect(elementToolbarKind([item(kind)])).toBe(kind);
  });
  it("keeps notes on the note toolbar and leaves uncovered objects to the engine", () => {
    expect(elementToolbarKind([item("note", true)])).toBeNull();
    expect(elementToolbarKind([item("mindmap")])).toBeNull();
    expect(elementToolbarKind([])).toBeNull();
  });
  it("styles several objects of one kind together, and mixes otherwise", () => {
    expect(elementToolbarKind([item("shape"), item("shape")])).toBe("shape");
    expect(elementToolbarKind([item("shape"), item("note", true)])).toBe("mixed");
    expect(elementToolbarKind([item("image"), item("image")])).toBe("mixed");
  });
});

describe("toolbar values", () => {
  it("round-trips shape types, including rounded rectangles", () => {
    expect(shapeTypePatch("roundedRect")).toEqual({ shapeType: "rect", radius: 0.1 });
    expect(shapeChoice({ shapeType: "rect", radius: 0.1 })).toBe("roundedRect");
    expect(shapeChoice({ shapeType: "rect", radius: 0 })).toBe("rect");
    expect(shapeChoice({ shapeType: "diamond" })).toBe("diamond");
  });
  it("matches stored colours by their light value and draws them per theme", () => {
    expect(sameColor({ light: "#FFFFFF", dark: "#283347" }, { light: "#ffffff", dark: "#000" })).toBe(true);
    expect(sameColor("transparent", null)).toBe(true);
    expect(displayColor({ light: "#fff", dark: "#000" }, true)).toBe("#000");
    expect(displayColor("#123456", true)).toBe("#123456");
    expect(displayColor({ key: "x" }, false, "fallback")).toBe("fallback");
  });
  it("fits a frame around its contents with room for the title", () => {
    expect(frameFitBounds([{ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 50, w: 50, h: 50 }], 40)).toEqual({ x: -40, y: -40, w: 330, h: 180 });
    expect(frameFitBounds([])).toBeNull();
  });
});
