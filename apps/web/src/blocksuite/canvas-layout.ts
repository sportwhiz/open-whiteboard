type Box = { left: number; top: number; right: number; bottom: number };
type Padding = [number, number, number, number];

/** Floating board chrome that content should not be fitted underneath. */
const CHROME = [
  ".app-header .board-heading",
  ".app-header .header-actions",
  ".follow-banner",
  ".canvas-utilities",
  ".creation-rail",
  ".canvas-history",
  ".canvas-bottom-right",
  ".collaboration-panel",
  ".history-panel",
].join(", ");

/**
 * Turn the chrome floating over the canvas into fit padding. Each rectangle
 * is assigned to the edge it hugs: tall panels at the right reserve width,
 * bars in the top or bottom part reserve height, rails at a side reserve width.
 */
export function fitPaddingFromChrome(host: Box, chrome: Box[], gap: number): Padding {
  const width = host.right - host.left;
  const height = host.bottom - host.top;
  let [top, right, bottom, left] = [0, 0, 0, 0];
  for (const rect of chrome) {
    const box = { left: rect.left - host.left, top: rect.top - host.top, right: rect.right - host.left, bottom: rect.bottom - host.top };
    if (box.right <= 0 || box.left >= width || box.bottom <= 0 || box.top >= height) continue;
    const tall = box.bottom - box.top > height * 0.5;
    if (tall && box.left > width * 0.5) right = Math.max(right, width - box.left);
    else if (tall && box.right < width * 0.5) left = Math.max(left, box.right);
    else if (box.bottom < height * 0.4) top = Math.max(top, box.bottom);
    else if (box.top > height * 0.6) bottom = Math.max(bottom, height - box.top);
    else if (box.right < width * 0.4) left = Math.max(left, box.right);
    else if (box.left > width * 0.6) right = Math.max(right, width - box.left);
  }
  return [top + gap, right + gap, bottom + gap, left + gap];
}

/** Keep fitted content clear of the floating header, rails and side panels. */
export function canvasFitPadding(host: HTMLElement): Padding {
  const small = host.clientWidth <= 600;
  // Before the canvas chrome mounts (the first fit), assume its usual size.
  const fallback: Padding = small ? [140, 16, 150, 16] : [96, 32, 80, 96];
  const shell = host.closest(".app-shell") ?? host.parentElement ?? host;
  const rects = Array.from(shell.querySelectorAll<HTMLElement>(CHROME), (element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  const measured = fitPaddingFromChrome(host.getBoundingClientRect(), rects, small ? 12 : 32);
  const mounted = Boolean(shell.querySelector(".creation-rail"));
  return measured.map((value, index) => (mounted ? value : Math.max(value, fallback[index]))) as Padding;
}

/** Fit bounds exactly inside the padding. The engine's own fit subtracts a
 * further fixed 100px, which shrank boards to a fraction of a phone screen. */
export function fitViewportData(
  bounds: { x: number; y: number; w: number; h: number },
  view: { width: number; height: number },
  [top, right, bottom, left]: Padding,
  maxZoom = 1,
) {
  const zoom = Math.min(
    maxZoom,
    Math.max(0.1, Math.min(
      (view.width - left - right) / Math.max(1, bounds.w),
      (view.height - top - bottom) / Math.max(1, bounds.h),
    )),
  );
  return {
    zoom,
    centerX: bounds.x + bounds.w / 2 + (right - left) / zoom / 2,
    centerY: bounds.y + bounds.h / 2 + (bottom - top) / zoom / 2,
  };
}

export function unionBounds(bounds: Array<{ x: number; y: number; w: number; h: number }>) {
  if (!bounds.length) return null;
  const x = Math.min(...bounds.map((bound) => bound.x));
  const y = Math.min(...bounds.map((bound) => bound.y));
  return {
    x, y,
    w: Math.max(...bounds.map((bound) => bound.x + bound.w)) - x,
    h: Math.max(...bounds.map((bound) => bound.y + bound.h)) - y,
  };
}

/** Fit the viewport to bounds (all content by default) inside the chrome. */
export function fitCanvas(
  host: HTMLElement,
  viewport: { width: number; height: number; setViewport(zoom: number, center: [number, number], smooth?: boolean): void },
  bounds: { x: number; y: number; w: number; h: number } | null,
  smooth: boolean,
) {
  if (!bounds) return;
  const { zoom, centerX, centerY } = fitViewportData(bounds, viewport, canvasFitPadding(host));
  viewport.setViewport(zoom, [centerX, centerY], smooth);
}

/** Pan just far enough to reveal an object without changing the user's zoom. */
export function revealDelta(
  box: { x: number; y: number; w: number; h: number },
  width: number, height: number,
  [top, right, bottom, left]: [number, number, number, number],
) {
  const axis = (start: number, size: number, min: number, max: number) =>
    size > max - min ? start + size / 2 - (min + max) / 2 :
      start < min ? start - min : Math.max(0, start + size - max);
  return { x: axis(box.x, box.w, left, width - right), y: axis(box.y, box.h, top, height - bottom) };
}

/** The part of the board a person can see, in model coordinates: the canvas
 * minus any side panel overlaying its right edge. */
export function visibleModelArea(
  host: HTMLElement,
  viewport: { toModelCoord(x: number, y: number): [number, number] },
) {
  const origin = host.getBoundingClientRect();
  const panels = Array.from(host.closest(".app-shell")?.querySelectorAll(".collaboration-panel, .history-panel") ?? [],
    (panel) => panel.getBoundingClientRect());
  return visibleArea({ width: origin.width, height: origin.height }, panels.map((rect) => ({ left: rect.left - origin.left, width: rect.width, height: rect.height })), viewport);
}

/** Pure part of visibleModelArea: panels anchored right of centre and at
 * least half the canvas tall narrow the visible width. */
export function visibleArea(
  view: { width: number; height: number },
  panels: Array<{ left: number; width: number; height: number }>,
  viewport: { toModelCoord(x: number, y: number): [number, number] },
) {
  const right = Math.min(view.width, ...panels
    .filter((panel) => panel.width > 0 && panel.left > view.width / 2 && panel.left < view.width && panel.height > view.height / 2)
    .map((panel) => panel.left));
  const [x, y] = viewport.toModelCoord(0, 0);
  const [x2, y2] = viewport.toModelCoord(right, view.height);
  return { x, y, width: x2 - x, height: y2 - y };
}
