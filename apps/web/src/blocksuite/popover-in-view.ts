import { useLayoutEffect, type RefObject } from "react";
import { canvasFitPadding } from "./canvas-layout";

/**
 * Keep a toolbar menu fully visible: it opens away from the selection, but
 * flips to the other side when the floating header or bottom bars would
 * cover it, and slides inward at the screen edges.
 */
export function usePopoverInView(panel: RefObject<HTMLElement>, open: unknown, host: HTMLElement) {
  useLayoutEffect(() => {
    const element = panel.current;
    if (!open || !element) return;
    element.removeAttribute("data-flip");
    element.style.removeProperty("margin-left");
    const origin = host.getBoundingClientRect();
    const [top, , bottom] = canvasFitPadding(host);
    const safeTop = origin.top + Math.max(8, top - 24);
    const safeBottom = origin.bottom - Math.max(8, bottom - 24);
    let rect = element.getBoundingClientRect();
    if (rect.top < safeTop) element.dataset.flip = "down";
    else if (rect.bottom > safeBottom) element.dataset.flip = "up";
    rect = element.getBoundingClientRect();
    const overflowLeft = 8 - rect.left;
    const overflowRight = rect.right - (window.innerWidth - 8);
    if (overflowLeft > 0) element.style.marginLeft = `${overflowLeft}px`;
    else if (overflowRight > 0) element.style.marginLeft = `${-overflowRight}px`;
  });
}
