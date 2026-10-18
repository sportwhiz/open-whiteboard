/**
 * Where revealed brainstorm ideas go on the board.
 *
 * Revealed ideas are laid out as a tidy grid inside a new frame. The frame is
 * placed where the facilitator is looking when that space is clear, otherwise
 * in the nearest clear space around it, and finally beside existing content.
 * It never overlaps existing frames, notes or shapes. Both the Cloudflare
 * Durable Object and the Node.js room use this through BoardRoom.
 */
export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

export const REVEAL_NOTE_SIZE = 208;
export const REVEAL_GAP = 32;
export const REVEAL_PADDING = 48;
/** Breathing room kept between the new frame and existing content. */
export const REVEAL_CLEARANCE = 120;
/** Native board coordinates and frame sizes are bounded (native-operation-schema). */
export const REVEAL_COORDINATE_LIMIT = 1_000_000;
const MAX_COLUMNS = 30;

export function revealGrid(count: number) {
  // Up to five ideas sit in one row; larger sets form a wide, roughly 8:5 grid
  // whose frame stays within the native 20,000 unit frame limit (500 ideas).
  const columns = Math.max(1, count <= 5 ? count : Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(count * 1.6))));
  const rows = Math.max(1, Math.ceil(count / columns));
  const width = REVEAL_PADDING * 2 + columns * REVEAL_NOTE_SIZE + (columns - 1) * REVEAL_GAP;
  const height = REVEAL_PADDING * 2 + rows * REVEAL_NOTE_SIZE + (rows - 1) * REVEAL_GAP;
  return { columns, rows, width, height };
}

/** Top-left position of the note at `index` inside a frame at `frame`. */
export function revealNotePosition(frame: Point, index: number, columns: number): Point {
  return {
    x: frame.x + REVEAL_PADDING + (index % columns) * (REVEAL_NOTE_SIZE + REVEAL_GAP),
    y: frame.y + REVEAL_PADDING + Math.floor(index / columns) * (REVEAL_NOTE_SIZE + REVEAL_GAP),
  };
}

function overlaps(a: Rect, b: Rect, clearance: number) {
  return a.x < b.x + b.width + clearance && b.x < a.x + a.width + clearance &&
    a.y < b.y + b.height + clearance && b.y < a.y + a.height + clearance;
}

function clear(candidate: Rect, occupied: Rect[], clearance: number) {
  return !occupied.some(rect => overlaps(candidate, rect, clearance));
}

/** Parse a BlockSuite `[x,y,w,h]` string, ignoring malformed or empty geometry. */
export function parseBounds(value: unknown): Rect | null {
  if (typeof value !== 'string') return null;
  try {
    const box: unknown = JSON.parse(value);
    if (!Array.isArray(box) || box.length !== 4 || !box.every(n => typeof n === 'number' && Number.isFinite(n))) return null;
    const [x, y, width, height] = box as number[];
    return width > 0 && height > 0 ? { x, y, width, height } : null;
  } catch { return null; }
}

/**
 * Choose the frame's top-left corner.
 *
 * 1. Centered on `preferred` (the facilitator's view) when that is clear.
 * 2. Otherwise the nearest clear slot in rings around `preferred`.
 * 3. Otherwise to the right of everything (or below, if that is closer to
 *    `preferred`), aligned with the content's top or left edge.
 */
export function placeRevealFrame(size: { width: number; height: number }, occupied: Rect[], preferred?: Point | null, clearance = REVEAL_CLEARANCE): Point {
  const rects = occupied.filter(rect => Number.isFinite(rect.x + rect.y + rect.width + rect.height) && rect.width > 0 && rect.height > 0);
  const centered = (point: Point) => ({ x: Math.round(point.x - size.width / 2), y: Math.round(point.y - size.height / 2) });
  if (!rects.length) return centered(preferred ?? { x: size.width / 2, y: size.height / 2 });
  if (preferred) {
    const start = centered(preferred);
    if (clear({ ...start, ...size }, rects, clearance)) return start;
    // Search outward in half-frame steps; nearer slots win.
    const stepX = Math.max(160, size.width / 2);
    const stepY = Math.max(160, size.height / 2);
    for (let ring = 1; ring <= 3; ring += 1) {
      const candidates: Point[] = [];
      for (let dx = -ring; dx <= ring; dx += 1) for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        candidates.push({ x: start.x + dx * stepX, y: start.y + dy * stepY });
      }
      candidates.sort((a, b) => Math.hypot(a.x - start.x, a.y - start.y) - Math.hypot(b.x - start.x, b.y - start.y));
      const found = candidates.find(candidate => clear({ ...candidate, ...size }, rects, clearance));
      if (found) return { x: Math.round(found.x), y: Math.round(found.y) };
    }
  }
  const left = Math.min(...rects.map(rect => rect.x));
  const top = Math.min(...rects.map(rect => rect.y));
  const right = Math.max(...rects.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
  const beside = { x: Math.round(right + clearance), y: Math.round(top) };
  const below = { x: Math.round(left), y: Math.round(bottom + clearance) };
  if (!preferred) return beside;
  const distance = (point: Point) => Math.hypot(point.x + size.width / 2 - preferred.x, point.y + size.height / 2 - preferred.y);
  return distance(below) < distance(beside) ? below : beside;
}

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Resolve where a reveal goes from a command's values. `x` and `y` together
 * keep their historical meaning (the frame's top-left corner); `nearX` and
 * `nearY` are the facilitator's view. The frame always stays inside the
 * native coordinate range.
 */
export function revealOrigin(values: Record<string, unknown>, size: { width: number; height: number }, occupied: () => Rect[]): Point {
  const hasX = values.x !== undefined && values.x !== null;
  const hasY = values.y !== undefined && values.y !== null;
  if (hasX !== hasY) throw new Error('Give both x and y for the revealed ideas, or neither to place them automatically.');
  if (hasX && (!finiteNumber(values.x) || !finiteNumber(values.y))) throw new Error('x and y must be numbers.');
  const clampAxis = (value: number, extent: number) => Math.round(Math.min(REVEAL_COORDINATE_LIMIT - extent, Math.max(-REVEAL_COORDINATE_LIMIT, value)));
  const clampPoint = (point: Point) => ({ x: clampAxis(point.x, size.width), y: clampAxis(point.y, size.height) });
  if (hasX) return clampPoint({ x: values.x as number, y: values.y as number });
  const near = finiteNumber(values.nearX) && finiteNumber(values.nearY)
    ? { x: Math.max(-REVEAL_COORDINATE_LIMIT, Math.min(REVEAL_COORDINATE_LIMIT, values.nearX)), y: Math.max(-REVEAL_COORDINATE_LIMIT, Math.min(REVEAL_COORDINATE_LIMIT, values.nearY)) }
    : null;
  return clampPoint(placeRevealFrame(size, occupied(), near));
}

/** Split revealed notes into native operation batches (each at most `limit`). */
export function revealBatches<T>(frame: T, notes: T[], limit = 100): T[][] {
  const batches: T[][] = [[frame, ...notes.slice(0, limit - 1)]];
  for (let index = limit - 1; index < notes.length; index += limit) batches.push(notes.slice(index, index + limit));
  return batches;
}
