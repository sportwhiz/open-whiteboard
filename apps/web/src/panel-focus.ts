/**
 * When the side panel may move keyboard focus on its own: only when the
 * control someone was using inside the panel has disappeared or been
 * disabled (a vote reaching its cap, a remote "End vote"), and focus has not
 * gone anywhere else. Someone who clicked or typed elsewhere keeps focus.
 */
export function shouldRescueFocus({ lostConnected, lostDisabled, activeIsBody, activeIsLost }: {
  lostConnected: boolean;
  lostDisabled: boolean;
  activeIsBody: boolean;
  activeIsLost: boolean;
}) {
  const gone = !lostConnected || lostDisabled;
  return gone && (activeIsBody || activeIsLost);
}

export type CanvasView = { x: number; y: number; zoom?: number };

/**
 * The centre of the visible canvas in board coordinates, asked of the canvas
 * synchronously (it accounts for the side panel). Falls back to the last
 * presence update when the canvas does not answer.
 */
export function visibleCanvasCentre(fallback?: CanvasView | null): CanvasView | null {
  const holder: { viewport?: CanvasView } = {};
  window.dispatchEvent(new CustomEvent('whiteboard-viewport-query', { detail: holder }));
  const view = holder.viewport;
  if (view && Number.isFinite(view.x) && Number.isFinite(view.y)) return view;
  return fallback ?? null;
}

/** What the canvas reports about itself right now (see whiteboard-viewport-query). */
export function queryCanvas(): { viewport?: CanvasView; bounds?: { x: number; y: number; width: number; height: number }; selection?: string[] } {
  const holder: { viewport?: CanvasView; selection?: unknown } = {};
  window.dispatchEvent(new CustomEvent('whiteboard-viewport-query', { detail: holder }));
  return { ...holder, selection: Array.isArray(holder.selection) ? holder.selection.filter((id): id is string => typeof id === 'string') : undefined };
}

/**
 * Run once the canvas is ready to move (it answers viewport queries), and
 * has had a moment to finish its initial fit. Returns a cancel function.
 */
export function whenCanvasReady(callback: () => void, { settle = 450, timeout = 15_000 } = {}) {
  let timer = 0;
  const started = Date.now();
  const check = () => {
    if (queryCanvas().viewport) { timer = window.setTimeout(callback, settle); return; }
    if (Date.now() - started < timeout) timer = window.setTimeout(check, 150);
  };
  check();
  return () => window.clearTimeout(timer);
}
