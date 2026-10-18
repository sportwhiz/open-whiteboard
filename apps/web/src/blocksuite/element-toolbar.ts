import { STICKY_PALETTE } from "./sticky-palette";

/** Which product toolbar a selection gets. Notes have their own toolbar;
 * null leaves the engine's (docked) toolbar for objects we do not cover
 * (document notes, mind maps, embeds, attachments). */
export type ElementToolbarKind = "shape" | "connector" | "text" | "image" | "frame" | "group" | "mixed";

const COVERED = new Set(["shape", "connector", "text", "image", "frame", "group", "note"]);

export function elementToolbarKind(selection: { kind: string; simpleSticky: boolean }[]): ElementToolbarKind | null {
  if (!selection.length) return null;
  const kinds = new Set(selection.map((item) => item.kind));
  if (selection.length > 1) {
    if (kinds.size === 1) {
      const [only] = kinds;
      if (only === "shape" || only === "connector" || only === "text") return only;
    }
    // Any multi-selection gets the shared actions (arrange, group, lock…).
    return "mixed";
  }
  const [item] = selection;
  if (!COVERED.has(item.kind) || item.kind === "note") return null;
  return item.kind as ElementToolbarKind;
}

export type ThemeColor = { light: string; dark: string };
export type Swatch = { name: string; value: ThemeColor | null };

/** Shape fills: white, the sticky papers, grey, or no fill. */
export const SHAPE_FILLS: Swatch[] = [
  { name: "White", value: { light: "#ffffff", dark: "#283347" } },
  ...STICKY_PALETTE.map((family) => ({ name: family.name, value: { light: family.light, dark: family.dark } })),
  { name: "Grey", value: { light: "#e6e9ef", dark: "#3a4250" } },
  { name: "No fill", value: null },
];

/** Strokes and lines: legible in both themes. */
export const STROKES: Swatch[] = [
  { name: "Slate", value: { light: "#425574", dark: "#b9c5dc" } },
  { name: "Grey", value: { light: "#5c6980", dark: "#aab7cf" } },
  { name: "Blue", value: { light: "#2554c7", dark: "#8eaaf5" } },
  { name: "Red", value: { light: "#c6392d", dark: "#f09083" } },
  { name: "Green", value: { light: "#23805a", dark: "#83cfa2" } },
  { name: "Amber", value: { light: "#b26a00", dark: "#f2c46b" } },
  { name: "Purple", value: { light: "#6a4bc4", dark: "#bba7f5" } },
];

/** Canvas text: ink that flips with the theme, plus accents. */
export const TEXT_COLORS: Swatch[] = [
  { name: "Ink", value: { light: "#23304a", dark: "#eef2fb" } },
  ...STROKES.slice(2),
];

export const STROKE_WIDTHS = [
  { name: "Thin", value: 1 },
  { name: "Medium", value: 2 },
  { name: "Thick", value: 4 },
];

export const TEXT_SIZES = [
  { name: "Small", value: 14 },
  { name: "Medium", value: 20 },
  { name: "Large", value: 28 },
  { name: "Extra large", value: 40 },
];

export const CANVAS_FONTS = [
  { name: "Sans", value: "blocksuite:surface:Inter" },
  { name: "Rounded", value: "blocksuite:surface:Poppins" },
  { name: "Serif", value: "blocksuite:surface:Lora" },
  { name: "Hand", value: "blocksuite:surface:Kalam" },
];

export type ShapeChoice = "rect" | "roundedRect" | "ellipse" | "diamond" | "triangle";
/** Props for a shape type; rounded rectangles are rectangles with a radius. */
export function shapeTypePatch(choice: ShapeChoice) {
  return choice === "roundedRect"
    ? { shapeType: "rect", radius: 0.1 }
    : { shapeType: choice, radius: 0 };
}
export function shapeChoice(props: { shapeType?: string; radius?: number }): ShapeChoice | null {
  if (props.shapeType === "rect") return (props.radius ?? 0) > 0 ? "roundedRect" : "rect";
  return props.shapeType === "ellipse" || props.shapeType === "diamond" || props.shapeType === "triangle" ? props.shapeType : null;
}

/** Whether a stored colour (plain or a light/dark pair) is this swatch. */
export function sameColor(stored: unknown, swatch: ThemeColor | null) {
  if (!swatch) return stored === null || stored === undefined || stored === "transparent";
  const light = typeof stored === "string" ? stored : stored && typeof stored === "object" ? (stored as { light?: unknown }).light : null;
  return typeof light === "string" && light.toLowerCase() === swatch.light.toLowerCase();
}

/** A representative colour to draw for a stored value in the given theme. */
export function displayColor(stored: unknown, dark: boolean, fallback = "transparent") {
  if (typeof stored === "string") return stored.startsWith("#") || stored.startsWith("rgb") ? stored : fallback;
  if (stored && typeof stored === "object") {
    const pair = stored as { light?: unknown; dark?: unknown; normal?: unknown };
    const value = dark ? pair.dark : pair.light;
    if (typeof value === "string") return value;
    if (typeof pair.normal === "string") return pair.normal;
  }
  return fallback;
}

/** A frame shrunk or grown to wrap its contents with room for its title. */
export function frameFitBounds(children: { x: number; y: number; w: number; h: number }[], padding = 40) {
  if (!children.length) return null;
  const x = Math.min(...children.map((b) => b.x)) - padding;
  const y = Math.min(...children.map((b) => b.y)) - padding;
  const right = Math.max(...children.map((b) => b.x + b.w)) + padding;
  const bottom = Math.max(...children.map((b) => b.y + b.h)) + padding;
  return { x, y, w: right - x, h: bottom - y };
}
