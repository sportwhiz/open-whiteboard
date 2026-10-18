import { describe, expect, it } from "vitest";
import {
  STICKY_PALETTE,
  notePaperColor,
  resolveStickyPaper,
  sameStickyFamily,
  stickyFamily,
  stickyPaper,
} from "./sticky-palette";

const NOTE_FALLBACK = { light: "#ffffff", dark: "#252525" };

describe("sticky palette", () => {
  it("has one entry per family with distinct, theme-aware paper", () => {
    expect(new Set(STICKY_PALETTE.map((family) => family.id)).size).toBe(STICKY_PALETTE.length);
    for (const family of STICKY_PALETTE) expect(family.dark).not.toBe(family.light);
  });

  it.each([
    ["yellow", "#fde68a", "#704200"],
    ["orange", "#ffc58f", "#843b06"],
    ["green", "#c9f8c1", "#3b5315"],
    ["blue", "#ceecff", "#004b7b"],
    ["purple", "#ddd6fe", "#312e81"],
  ])("maps original MCP %s notes to the unified family", (id, light, dark) => {
    const family = STICKY_PALETTE.find((item) => item.id === id)!;
    expect(stickyFamily({ light, dark })).toBe(family);
    expect(resolveStickyPaper({ light, dark })).toEqual({ light: family.light, dark: family.dark });
    expect(stickyPaper(id)).toEqual({ light: family.light, dark: family.dark });
  });

  it("gives UI notes saved with dark = light their dark variant", () => {
    expect(resolveStickyPaper({ light: "#ffd2df", dark: "#ffd2df" })).toEqual({ light: "#ffd2df", dark: "#f2afc2" });
    expect(resolveStickyPaper({ light: "#CCEAFF", dark: "#cceaff" })).toEqual({ light: "#cceaff", dark: "#a9d4f1" });
  });

  it("never maps plain strings or dark legacy colours", () => {
    for (const color of ["#312e81", "#704200", "#004b7b", "blue", "#cceaff", { light: "#312e81", dark: "#312e81" }])
      expect(resolveStickyPaper(color)).toBeUndefined();
    expect(stickyFamily("#312e81")).toBeNull();
    expect(stickyFamily({ light: "#004b7b", dark: "#004b7b" })).toBeNull();
  });

  it("keeps a custom night colour but still recognises the family for the swatch", () => {
    const custom = { light: "#fff0a6", dark: "#123456" };
    expect(resolveStickyPaper(custom)).toBeUndefined();
    expect(stickyFamily(custom)?.id).toBe("yellow");
  });

  it("matches the selected swatch by family, not exact hex", () => {
    expect(sameStickyFamily({ light: "#fde68a", dark: "#704200" }, "#fff0a6")).toBe(true);
    expect(sameStickyFamily("#ceecff", "#cceaff")).toBe(true);
    expect(sameStickyFamily("#ceecff", "#fff0a6")).toBe(false);
    expect(sameStickyFamily("#123456", "#123456")).toBe(true);
  });

  it("leaves custom colors and native palette references unchanged", () => {
    for (const color of [
      { light: "#fde68a", dark: "#123456" },
      { light: { key: "yellow" }, dark: { key: "yellow" } },
      null,
      "transparent",
    ])
      expect(resolveStickyPaper(color)).toBeUndefined();
  });

  it("only remaps colours rendered as note paper", () => {
    const legacy = { light: "#ddd6fe", dark: "#312e81" };
    expect(notePaperColor(legacy, NOTE_FALLBACK, NOTE_FALLBACK)).toEqual({ light: "#ded6ff", dark: "#bfb2f2" });
    // A shape with the same stored pair (or a dark fill with white text) keeps it.
    expect(notePaperColor(legacy, "#000000", NOTE_FALLBACK)).toBe(legacy);
    expect(notePaperColor("#312e81", undefined, NOTE_FALLBACK)).toBe("#312e81");
    expect(notePaperColor({ light: "#123456", dark: "#123456" }, { ...NOTE_FALLBACK }, NOTE_FALLBACK)).toEqual({ light: "#123456", dark: "#123456" });
  });
});
