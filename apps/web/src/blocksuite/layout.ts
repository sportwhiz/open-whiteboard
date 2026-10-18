export type LayoutBox = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};
export type Arrangement =
  | "left"
  | "center"
  | "right"
  | "top"
  | "middle"
  | "bottom"
  | "horizontal"
  | "vertical"
  | "grid";

const UNARRANGEABLE = new Set(["connector", "frame", "group", "mindmap"]);
/** Objects that Arrange may move. Frame children stay arrangeable (and stay in
 * their frame); members of a real group move with their group instead. */
export function canArrange(item: { kind: string; locked: boolean; inGroup: boolean }) {
  return !item.locked && !item.inGroup && !UNARRANGEABLE.has(item.kind);
}

export type Direction = "right" | "down" | "left" | "up";
export const CONNECTION_PORTS: Record<
  Direction,
  { source: [number, number]; target: [number, number] }
> = {
  right: { source: [1, 0.5], target: [0, 0.5] },
  down: { source: [0.5, 1], target: [0.5, 0] },
  left: { source: [0, 0.5], target: [1, 0.5] },
  up: { source: [0.5, 0], target: [0.5, 1] },
};
/** Keep branches on the requested side, even when another node occupies it. */
export function connectedPosition(
  source: LayoutBox,
  direction: Direction,
  obstacles: LayoutBox[],
  size: Pick<LayoutBox, "w" | "h"> = source,
): LayoutBox {
  const horizontal = direction === "right" || direction === "left";
  const next = {
    ...source,
    w: size.w,
    h: size.h,
    id: "new",
    x: source.x + (source.w - size.w) / 2,
    y: source.y + (source.h - size.h) / 2,
  };
  if (direction === "right") next.x = source.x + source.w + 96;
  if (direction === "left") next.x = source.x - size.w - 96;
  if (direction === "down") next.y = source.y + source.h + 96;
  if (direction === "up") next.y = source.y - size.h - 96;
  for (let attempt = 0; attempt <= obstacles.length; attempt++) {
    const collisions = obstacles.filter(
      (b) =>
        next.x < b.x + b.w + 24 &&
        next.x + next.w + 24 > b.x &&
        next.y < b.y + b.h + 24 &&
        next.y + next.h + 24 > b.y,
    );
    if (!collisions.length) return next;
    if (horizontal) next.y = Math.max(...collisions.map((b) => b.y + b.h + 32));
    else next.x = Math.max(...collisions.map((b) => b.x + b.w + 32));
  }
  return next;
}

/** Keep quick-created notes in the requested column, clear of existing objects. */
export function findOpenPosition(
  box: LayoutBox,
  obstacles: LayoutBox[],
  gap = 32,
): LayoutBox {
  let result = { ...box };
  // Every collision advances past at least one obstacle's bottom edge.
  for (let attempt = 0; attempt <= obstacles.length; attempt++) {
    const collisions = obstacles.filter(
      (other) =>
        result.x < other.x + other.w + gap &&
        result.x + result.w + gap > other.x &&
        result.y < other.y + other.h + gap &&
        result.y + result.h + gap > other.y,
    );
    if (!collisions.length) return result;
    result = {
      ...result,
      y: Math.max(...collisions.map((other) => other.y + other.h + gap)),
    };
  }
  return result;
}

/** Compute positions without mutating objects; sorting is deterministic. */
export function arrangeBoxes(
  boxes: LayoutBox[],
  action: Arrangement,
): LayoutBox[] {
  if (boxes.length < 2) return boxes;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  if (action === "grid") {
    // Keep reading order; objects already roughly in one row stay one row.
    const rows = readingRows(boxes);
    const columns = rows.length === 1 ? boxes.length : Math.ceil(Math.sqrt(boxes.length));
    const width = Math.max(...boxes.map((b) => b.w)) + 32;
    const height = Math.max(...boxes.map((b) => b.h)) + 32;
    return rows.flat()
      .map((b, index) => ({
        ...b,
        x: left + (index % columns) * width,
        y: top + Math.floor(index / columns) * height,
      }));
  }
  if (action === "horizontal" || action === "vertical") {
    if (boxes.length < 3) return boxes;
    const horizontal = action === "horizontal";
    const position = horizontal ? "x" : "y";
    const size = horizontal ? "w" : "h";
    const sorted = [...boxes].sort(
      (a, b) => a[position] - b[position] || a.id.localeCompare(b.id),
    );
    const first = sorted[0][position];
    const last = sorted[sorted.length - 1];
    const span = last[position] + last[size] - first;
    const gap =
      (span - sorted.reduce((sum, box) => sum + box[size], 0)) /
      (sorted.length - 1);
    let cursor = first;
    return sorted.map((box) => {
      const result = { ...box, [position]: cursor };
      cursor += box[size] + gap;
      return result;
    });
  }
  return boxes.map((b) => ({
    ...b,
    x:
      action === "left"
        ? left
        : action === "center"
          ? (left + right - b.w) / 2
          : action === "right"
            ? right - b.w
            : b.x,
    y:
      action === "top"
        ? top
        : action === "middle"
          ? (top + bottom - b.h) / 2
          : action === "bottom"
            ? bottom - b.h
            : b.y,
  }));
}

/** Keyboard reading order: rows top to bottom, each row left to right. An
 * object joins a row when its top is within half the row's shortest height
 * of the row's first object, so slightly uneven rows still read naturally. */
export function readingOrder<T extends LayoutBox>(boxes: T[]): T[] {
  return readingRows(boxes).flat();
}

/** The rows readingOrder reads, each sorted left to right. */
export function readingRows<T extends LayoutBox>(boxes: T[]): T[][] {
  const byTop = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const rows: T[][] = [];
  for (const box of byTop) {
    const row = rows.at(-1);
    if (row && box.y - row[0].y <= Math.min(row[0].h, ...row.map((item) => item.h), box.h) / 2) row.push(box);
    else rows.push([box]);
  }
  return rows.map((row) => row.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id)));
}

/** Relative ports on the sides of two objects that face each other, for a
 * connector drawn between them without aiming at a particular point. */
export function facingPorts(source: Omit<LayoutBox, "id">, target: Omit<LayoutBox, "id">): { source: [number, number]; target: [number, number] } {
  const dx = target.x + target.w / 2 - (source.x + source.w / 2);
  const dy = target.y + target.h / 2 - (source.y + source.h / 2);
  // Compare against the boxes' combined half sizes so tall or wide objects
  // still connect along the axis where they are actually apart.
  const horizontal = Math.abs(dx) / Math.max(1, (source.w + target.w) / 2) >= Math.abs(dy) / Math.max(1, (source.h + target.h) / 2);
  if (horizontal)
    return dx >= 0 ? { source: [1, 0.5], target: [0, 0.5] } : { source: [0, 0.5], target: [1, 0.5] };
  return dy >= 0 ? { source: [0.5, 1], target: [0.5, 0] } : { source: [0.5, 0], target: [0.5, 1] };
}

type Port = [number, number];
type Bounds = Omit<LayoutBox, "id">;
/**
 * The ports a dragged connector keeps. An end counts as aimed only when the
 * pointer was released on (within a few screen pixels of) the anchor the
 * engine bound it to, and nearer that anchor than the object's middle - so
 * a release inside an object, even a small zoomed-out one, never pins an
 * edge point. Unaimed ends join the facing sides.
 */
export function connectorEndPorts({ start, end, source, target, sourcePort, targetPort, zoom, reach = 14 }: {
  /** Pointer at press and release, in model coordinates. */
  start: [number, number];
  end: [number, number];
  source: Bounds;
  target: Bounds;
  /** Anchors the engine bound each end to, if any. */
  sourcePort?: Port;
  targetPort?: Port;
  zoom: number;
  reach?: number;
}): { source: Port; target: Port } {
  const aimed = (point: [number, number], box: Bounds, port?: Port): port is Port => {
    if (!port) return false;
    const toAnchor = Math.hypot(box.x + box.w * port[0] - point[0], box.y + box.h * port[1] - point[1]);
    const toMiddle = Math.hypot(box.x + box.w / 2 - point[0], box.y + box.h / 2 - point[1]);
    return toAnchor * zoom <= reach && toAnchor < toMiddle;
  };
  const facing = facingPorts(source, target);
  return {
    source: aimed(start, source, sourcePort) ? sourcePort : facing.source,
    target: aimed(end, target, targetPort) ? targetPort : facing.target,
  };
}

/**
 * Where the next note goes (Tab / Cmd+Enter): to the right of the source,
 * clear of other objects. Inside a frame it stays in that frame - wrapping
 * to a new row at the frame's left when the row is full, growing the frame
 * downward if needed - and never crosses into another frame.
 */
export function nextNotePlacement(
  source: LayoutBox,
  obstacles: LayoutBox[],
  frames: LayoutBox[],
  frame: LayoutBox | null,
  gap = 32,
  inset = 24,
): { box: LayoutBox; frameHeight: number | null } {
  const size = { w: source.w, h: source.w };
  if (!frame) {
    const box = findOpenPosition({ ...source, ...size, x: source.x + source.w + gap }, [...obstacles, ...frames], gap);
    return { box, frameHeight: null };
  }
  const inside = obstacles.filter((other) => other.x < frame.x + frame.w && other.x + other.w > frame.x &&
    other.y < frame.y + frame.h && other.y + other.h > frame.y);
  // New rows line up with the notes already in the frame.
  const rowStart = inside.length ? Math.min(...inside.map((other) => other.x)) : frame.x + inset;
  let candidate: LayoutBox = { ...source, ...size, x: source.x + source.w + gap };
  if (candidate.x + candidate.w > frame.x + frame.w - inset)
    candidate = { ...candidate, x: Math.max(frame.x + inset, rowStart), y: source.y + source.h + gap };
  let box = findOpenPosition(candidate, inside, gap);
  const rowX = Math.max(frame.x + inset, rowStart);
  // A note wider than the frame's inside can never fit a row; wrapping would
  // only march it down. Give it the next row at the row start instead.
  const fitsRow = rowX + size.w <= frame.x + frame.w - inset;
  if (!fitsRow && box.x + box.w > frame.x + frame.w - inset)
    box = findOpenPosition({ ...box, x: rowX, y: Math.max(box.y, source.y + source.h + gap) }, inside, gap);
  // A full row: try the next rows from the left before going further down.
  for (let attempt = 0; fitsRow && attempt < 50 && box.x + box.w > frame.x + frame.w - inset; attempt++)
    box = findOpenPosition({ ...box, x: rowX, y: box.y + box.h + gap }, inside, gap);
  const bottom = box.y + box.h + inset;
  return { box, frameHeight: bottom > frame.y + frame.h ? bottom - frame.y : null };
}

/** Where a duplicate goes: just right of the originals, clear of others. */
export function duplicatePlacement(original: Omit<LayoutBox, "id">, obstacles: LayoutBox[], gap = 32) {
  const box = findOpenPosition({ id: "copy", ...original, x: original.x + original.w + gap }, obstacles, gap);
  return { dx: box.x - original.x, dy: box.y - original.y };
}
