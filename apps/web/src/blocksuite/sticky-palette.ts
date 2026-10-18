/**
 * The one sticky-note palette used by the toolbar, templates, MCP/API
 * operations, headless boards and previews.
 *
 * Paper stays light in both themes so the dark sticky ink keeps its contrast;
 * the dark variant is a slightly muted tone that does not glare on the dark
 * canvas. Earlier boards stored other hexes for the same families (the
 * original MCP presets, with dark-brown night colors, and UI notes saved with
 * dark = light). Those still resolve to the right family at render time, so
 * existing documents never need rewriting.
 */
export type StickyFamilyId = "yellow" | "orange" | "pink" | "purple" | "blue" | "green";
export type StickyFamily = {
  id: StickyFamilyId;
  name: string;
  light: string;
  dark: string;
  /** Light/dark pairs that earlier versions stored for this family. */
  legacy: readonly { light: string; dark: string }[];
};

export const STICKY_PALETTE: readonly StickyFamily[] = [
  { id: "yellow", name: "Yellow", light: "#fff0a6", dark: "#ecdb89", legacy: [{ light: "#fde68a", dark: "#704200" }] },
  { id: "orange", name: "Peach", light: "#ffd6b0", dark: "#edbe91", legacy: [{ light: "#ffc58f", dark: "#843b06" }] },
  { id: "pink", name: "Pink", light: "#ffd2df", dark: "#f2afc2", legacy: [] },
  { id: "purple", name: "Lilac", light: "#ded6ff", dark: "#bfb2f2", legacy: [{ light: "#ddd6fe", dark: "#312e81" }] },
  { id: "blue", name: "Blue", light: "#cceaff", dark: "#a9d4f1", legacy: [{ light: "#ceecff", dark: "#004b7b" }] },
  { id: "green", name: "Mint", light: "#d2f2d0", dark: "#b5dfb3", legacy: [{ light: "#c9f8c1", dark: "#3b5315" }] },
];

export const DEFAULT_STICKY_FAMILY = STICKY_PALETTE[0];

// Only light papers identify a family. Dark legacy night colours (#312e81 is
// indigo-900) are ordinary colours elsewhere and must never map to paper.
const byLight = new Map<string, StickyFamily>();
for (const family of STICKY_PALETTE)
  for (const hex of [family.light, ...family.legacy.map((pair) => pair.light)]) byLight.set(hex, family);

const normalizeHex = (value: string) => {
  const hex = value.trim().toLowerCase();
  return /^#[0-9a-f]{3}$/u.test(hex) ? "#" + [...hex.slice(1)].map((c) => c + c).join("") : hex;
};
const lightOf = (color: unknown) => {
  if (typeof color === "string") return normalizeHex(color);
  const light = color && typeof color === "object" ? (color as { light?: unknown }).light : undefined;
  return typeof light === "string" ? normalizeHex(light) : null;
};

/** The palette family of a note's paper (by its light colour), or null. For
 * UI state such as the chosen swatch; rendering uses resolveStickyPaper. */
export function stickyFamily(color: unknown): StickyFamily | null {
  if (typeof color === "string") {
    const named = STICKY_PALETTE.find((family) => family.id === color);
    if (named) return named;
  }
  const light = lightOf(color);
  return light ? byLight.get(light) ?? null : null;
}

/** The stored value for a family, by id or by any of its light papers. */
export function stickyPaper(color: string): { light: string; dark: string } {
  const family = stickyFamily(color);
  return family ? { light: family.light, dark: family.dark } : { light: color, dark: color };
}

/** Whether two stored backgrounds belong to the same palette family. */
export function sameStickyFamily(a: unknown, b: unknown) {
  const left = stickyFamily(a);
  return left ? left === stickyFamily(b) : typeof a === "string" && a === b;
}

/**
 * Render-time normalization of a note's paper. Only a stored light/dark pair
 * whose light is a palette or legacy paper is remapped, and only when its
 * dark is one the product itself wrote (equal to light, the family's dark, or
 * the legacy pair's dark). Anything else, including a custom night colour,
 * is the author's choice and stays as stored.
 */
export function resolveStickyPaper(color: unknown): { light: string; dark: string } | undefined {
  if (!color || typeof color !== "object") return;
  const { light, dark } = color as { light?: unknown; dark?: unknown };
  if (typeof light !== "string" || typeof dark !== "string") return;
  const family = byLight.get(normalizeHex(light));
  if (!family) return;
  const night = normalizeHex(dark);
  const ours = night === normalizeHex(light) || night === family.dark ||
    family.legacy.some((pair) => pair.light === normalizeHex(light) && pair.dark === night);
  return ours ? { light: family.light, dark: family.dark } : undefined;
}

/** The colour a note block should render: only note backgrounds (resolved
 * with the engine's note fallback colour) go through the palette. */
export function notePaperColor<T>(color: T, fallback: unknown, noteFallback: unknown): T | { light: string; dark: string } {
  if (fallback === undefined || JSON.stringify(fallback) !== JSON.stringify(noteFallback)) return color;
  return resolveStickyPaper(color) ?? color;
}
