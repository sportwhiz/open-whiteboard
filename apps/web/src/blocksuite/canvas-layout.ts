/** Keep fitted content clear of the floating header and any desktop side panel. */
export function canvasFitPadding(host: HTMLElement): [number, number, number, number] {
  if (host.clientWidth <= 600) return [164, 24, 150, 24];
  const panels = host.closest('.app-shell')?.querySelectorAll<HTMLElement>('.collaboration-panel, .history-panel');
  const right = panels?.length && host.clientWidth > 760
    ? Math.max(...Array.from(panels, panel => panel.offsetWidth + 48))
    : 88;
  return [96, right, 80, 88];
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
