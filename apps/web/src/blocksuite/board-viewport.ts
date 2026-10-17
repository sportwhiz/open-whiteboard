export type BoardViewport = { x: number; y: number; zoom: number };

export function validBoardViewport(value: unknown): BoardViewport | null {
  if (!value || typeof value !== "object") return null;
  const { x, y, zoom } = value as Partial<BoardViewport>;
  if (typeof x !== "number" || typeof y !== "number" || typeof zoom !== "number" ||
      !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom) || zoom < 0.1 || zoom > 6)
    return null;
  return { x, y, zoom };
}

export function readBoardViewport(key: string): BoardViewport | null {
  try { return validBoardViewport(JSON.parse(localStorage.getItem(key) ?? "null")); }
  catch { return null; }
}

export function writeBoardViewport(key: string, viewport: BoardViewport) {
  try { if (validBoardViewport(viewport)) localStorage.setItem(key, JSON.stringify(viewport)); }
  catch { /* Remembering the view is optional when device storage is unavailable. */ }
}
