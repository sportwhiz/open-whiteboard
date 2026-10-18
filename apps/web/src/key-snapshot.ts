import { queryCanvas } from './panel-focus';

/**
 * What the canvas looked like when a key was pressed, before anything
 * handled it.
 *
 * The canvas handles Escape (and arrows) in a window capture listener and
 * clears the selection right there. Board-level shortcuts decide later, so
 * reading "is something selected?" then sees the already-cleared state —
 * on a slow machine every time. This listener is registered when the module
 * loads, before the canvas mounts, so it runs first among window capture
 * listeners (they run in registration order) and stamps each key event.
 */
export type KeySnapshot = { hadSelection: boolean };

const snapshots = new WeakMap<Event, KeySnapshot>();

/** Whether the canvas has something selected right now. */
export function canvasHasSelection() {
  const reported = queryCanvas().selection;
  if (reported) return reported.length > 0;
  // Until the canvas reports its selection, its note-selection state is a safe proxy.
  return Boolean(document.querySelector('.editor-canvas.whiteboard-note-selection, .whiteboard-note-selection .editor-canvas'));
}

function stamp(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key.startsWith('Arrow')) snapshots.set(event, { hadSelection: canvasHasSelection() });
}

const marker = '__whiteboardKeySnapshot';
if (typeof window !== 'undefined' && !(window as unknown as Record<string, unknown>)[marker]) {
  (window as unknown as Record<string, unknown>)[marker] = true;
  window.addEventListener('keydown', stamp, true);
}

/** The state captured for this key event before any handler ran. */
export function keySnapshot(event: Event | null | undefined): KeySnapshot | undefined {
  return event ? snapshots.get(event) : undefined;
}

/** For tests: stamp an event as the capture listener would. */
export const stampKeyEvent = stamp;
