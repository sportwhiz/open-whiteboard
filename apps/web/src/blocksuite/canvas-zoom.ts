/** Zoom levels people recognise. Buttons and shortcuts step through these so
 * the presets in the zoom menu are reachable and highlight when active. */
export const ZOOM_STEPS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6] as const;
export const ZOOM_PRESETS = [0.25, 0.5, 1, 2] as const;

/** The next step in a direction from any current zoom, including odd values
 * left by fitting or pinching. Clamped to the first and last step. */
export function steppedZoom(current: number, direction: 1 | -1) {
  // A step within 3% of the current zoom would be a visible no-op (66% → 67%).
  if (direction > 0) return ZOOM_STEPS.find((step) => step > current * 1.03) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((step) => step < current * 0.97) ?? ZOOM_STEPS[0];
}

/** Whether the zoom is visually at a level, tolerating float drift. */
export function isZoomAt(current: number, level: number) {
  return Math.abs(current - level) < 0.005;
}

export function zoomLabel(zoom: number) {
  return `${Math.round(zoom * 100)}%`;
}

export type ZoomCommand = "in" | "out" | "reset" | "fit" | "selection";

/** Keyboard zoom: ⌘/Ctrl + = − 0, and Shift + 0/1/2 as in other whiteboards.
 * Shift+digit uses the physical key so it works on every layout ("!" on US).
 * Selected objects do not take typed characters (Enter starts writing), so
 * these never collide with text. */
export function zoomCommandForKey(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  mac: boolean,
): ZoomCommand | null {
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (event.altKey) return null;
  if (command && !event.shiftKey || command && ["=", "+"].includes(event.key)) {
    if (["=", "+"].includes(event.key) || event.code === "Equal" || event.code === "NumpadAdd") return "in";
    if (["-", "_"].includes(event.key) || event.code === "Minus" || event.code === "NumpadSubtract") return "out";
    if (event.key === "0" || event.code === "Digit0" || event.code === "Numpad0") return "reset";
    return null;
  }
  if (event.shiftKey && !event.metaKey && !event.ctrlKey) {
    if (event.code === "Digit0") return "reset";
    if (event.code === "Digit1") return "fit";
    if (event.code === "Digit2") return "selection";
  }
  return null;
}
