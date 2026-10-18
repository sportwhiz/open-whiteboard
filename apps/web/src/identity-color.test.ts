import { describe, expect, it } from "vitest";
import { avatarInk } from "./avatar-color";
import {
  MARKER_COLORS,
  colorForId,
  isLegacyDefaultColor,
  leastUsedColor,
} from "./identity-color";

const palette: string[] = MARKER_COLORS.map((color) => color.value);

describe("account marker colors", () => {
  it("derives a stable palette color from an account id", () => {
    expect(palette).toContain(colorForId("user:mia"));
    expect(colorForId("user:mia")).toBe(colorForId("user:mia"));
    const spread = new Set(
      Array.from({ length: 60 }, (_, i) => colorForId(`user:${i}`)),
    );
    expect(spread.size).toBe(palette.length);
  });

  it("gives the first people in a Studio different colors", () => {
    const usage = new Map<string, number>();
    const chosen = ["user:olivia", "user:mia", "user:vera", "user:gus"].map(
      (id) => {
        const color = leastUsedColor(id, usage);
        usage.set(color, (usage.get(color) ?? 0) + 1);
        return color;
      },
    );
    expect(new Set(chosen).size).toBe(chosen.length);
  });

  it("ignores colors outside the palette when counting", () => {
    const usage = new Map([["#3d4a73", 12]]);
    expect(leastUsedColor("user:a", usage)).toBe(colorForId("user:a"));
  });

  it("recognizes the old shared defaults only", () => {
    expect(isLegacyDefaultColor("#3D4A73")).toBe(true);
    expect(isLegacyDefaultColor("#4262ff")).toBe(true);
    expect(isLegacyDefaultColor(palette[0])).toBe(false);
    expect(isLegacyDefaultColor(null)).toBe(false);
  });

  it("keeps avatar initials readable on every palette color", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((offset) => {
        const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const color of palette) {
      const [light, dark] = [luminance(color), luminance(avatarInk(color))]
        .sort((a, b) => b - a);
      expect((light + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
