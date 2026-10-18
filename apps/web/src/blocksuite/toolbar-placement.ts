export type Rect = { x: number; y: number; w: number; h: number };
export type ToolbarSide = "above" | "below" | "inside";
export type ToolbarPlacement = { x: number; y: number; side: ToolbarSide };

const intersects = (a: Rect, b: Rect, margin = 0) =>
  a.x < b.x + b.w + margin && a.x + a.w + margin > b.x &&
  a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Place a contextual toolbar next to a selection the way people expect from
 * other whiteboards: above it when there is room (including room for its
 * menus, which open away from the selection), otherwise below, and never over
 * the selection's own handles, a frame title or the floating board chrome.
 * When the selection fills the view, pin the toolbar inside its top edge.
 */
export function placeToolbar({
  target,
  size,
  bounds,
  obstacles = [],
  softObstacles = [],
  gap = 10,
  handleClearance = 0,
  menuRoom = 0,
}: {
  /** Selection, in canvas view coordinates. */
  target: Rect;
  size: { w: number; h: number };
  /** Area the toolbar must stay inside. */
  bounds: Rect;
  obstacles?: Rect[];
  /** Nearby objects: avoided when possible, never at the cost of chrome. */
  softObstacles?: Rect[];
  gap?: number;
  /** Extra space for handles drawn just outside the selection. */
  handleClearance?: number;
  /** Space a menu needs beyond the toolbar, on the side away from the selection. */
  menuRoom?: number;
}): ToolbarPlacement {
  const minX = bounds.x;
  const maxX = Math.max(minX, bounds.x + bounds.w - size.w);
  const clampX = (x: number) => Math.min(maxX, Math.max(minX, x));
  const centered = clampX(target.x + target.w / 2 - size.w / 2);
  const offset = gap + handleClearance;
  const above = target.y - offset - size.h;
  const below = target.y + target.h + offset;
  const top = bounds.y;
  const bottom = bounds.y + bounds.h;
  const sides: { side: ToolbarSide; y: number; fits: boolean }[] = [
    { side: "above", y: above, fits: above - menuRoom >= top },
    { side: "below", y: below, fits: below + size.h <= bottom },
    // Without room for menus above, still prefer above over covering the
    // selection, as long as the toolbar itself fits.
    { side: "above", y: above, fits: above >= top },
  ];
  // Horizontal alternatives: centred first, then just clear of whatever is
  // in the way, as long as the toolbar still reaches the selection.
  const reaches = (x: number) => x < target.x + target.w && x + size.w > target.x;
  const candidates: ToolbarPlacement[] = [];
  for (const { side, y, fits } of sides) {
    if (!fits) continue;
    const xs = [centered];
    for (const obstacle of [...obstacles, ...softObstacles]) {
      xs.push(clampX(obstacle.x + obstacle.w + 8), clampX(obstacle.x - size.w - 8));
    }
    for (const x of xs) if (reaches(x) || x === centered) candidates.push({ x, y, side });
  }
  const box = (placement: ToolbarPlacement): Rect => ({ x: placement.x, y: placement.y, w: size.w, h: size.h });
  const hits = (placement: ToolbarPlacement, list: Rect[]) => list.some((obstacle) => intersects(box(placement), obstacle, 2));
  const clear = candidates.find((placement) => !hits(placement, obstacles) && !hits(placement, softObstacles));
  if (clear) return clear;
  // Clear of the chrome, covering as little of the nearby objects as possible.
  const softCost = (placement: ToolbarPlacement) =>
    softObstacles.reduce((sum, obstacle) => sum + overlap(box(placement), obstacle), 0);
  const chromeClear = candidates.filter((placement) => !hits(placement, obstacles));
  if (chromeClear.length) return chromeClear.reduce((best, next) => (softCost(next) < softCost(best) ? next : best));
  if (candidates.length) {
    // Everything collides: take the smallest overlap, preferring the order above.
    const cost = (placement: ToolbarPlacement) =>
      obstacles.reduce((sum, obstacle) => sum + overlap(box(placement), obstacle), 0);
    return candidates.reduce((best, next) => (cost(next) < cost(best) ? next : best));
  }
  // The selection fills the view: sit inside its top edge, within bounds.
  const y = Math.min(Math.max(top, target.y + gap), Math.max(top, bottom - size.h));
  return { x: centered, y, side: "inside" };
}

/**
 * The narrowest content width that wraps these items into as few rows as
 * the available width allows, so a wrapped phone toolbar shows two even
 * rows instead of a full row and a lone straggler. Null when one row fits.
 */
export function balancedRowWidth(widths: number[], gap: number, available: number): number | null {
  const items = widths.filter((width) => width > 0);
  if (!items.length) return null;
  const rowsAt = (limit: number) => {
    let rows = 1, line = 0;
    for (const width of items) {
      const next = line ? line + gap + width : width;
      if (next > limit && line) { rows += 1; line = width; } else line = next;
    }
    return rows;
  };
  const rows = rowsAt(available);
  if (rows === 1) return null;
  let low = Math.max(...items), high = available;
  while (high - low > 1) {
    const mid = (low + high) / 2;
    if (rowsAt(mid) <= rows) high = mid; else low = mid;
  }
  return Math.ceil(high);
}
