import { useEffect, useRef, useState, type RefObject } from 'react';

const OPEN_EVENT = 'whiteboard:popover-open';
const controls = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
)).filter(item => item.getClientRects().length && !item.closest('[inert]'));

const visible = (element: HTMLElement) =>
  element.isConnected && element.getClientRects().length > 0 && !element.closest('[inert]') &&
  !element.closest('details:not([open]) > :not(summary)');

/**
 * Focus an element that may have been hidden by the action it triggered, such
 * as an item inside a menu that has just closed. Falls back to the menu's
 * visible trigger so keyboard users never land on the document body.
 */
export function focusOrFallback(element: HTMLElement | null | undefined, fallback?: HTMLElement | null) {
  if (element && visible(element)) { element.focus({ preventScroll: true }); return true; }
  const summary = element?.closest('details')?.querySelector<HTMLElement>(':scope > summary');
  for (const candidate of [summary, fallback]) {
    if (candidate && visible(candidate)) { candidate.focus({ preventScroll: true }); return true; }
  }
  return false;
}

export type PopoverOptions = {
  /** Return true after placing focus yourself, e.g. back into a text editor. */
  restoreFocus?: () => boolean;
  /** Move focus into the popover when it opens. Defaults to true. */
  autoFocus?: boolean;
};

/** One transient popover at a time, with keyboard navigation and focus return. */
export function usePopover(
  panel: RefObject<HTMLElement>,
  open: boolean,
  onClose: () => void,
  trigger?: RefObject<HTMLElement>,
  contentKey?: unknown,
  options: PopoverOptions = {},
) {
  const close = useRef(onClose);
  close.current = onClose;
  const settings = useRef(options);
  settings.current = options;
  const identity = useRef({});
  useEffect(() => {
    const root = panel.current;
    if (!open || !root) return;
    root.dataset.popover = "open";
    const previous = trigger?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const dismiss = (restore = false) => {
      close.current();
      if (!restore || settings.current.restoreFocus?.()) return;
      focusOrFallback(previous);
    };
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: identity.current }));
    if (settings.current.autoFocus !== false) (controls(root)[0] ?? root).focus({ preventScroll: true });
    const outside = (event: Event) => {
      const path = event.composedPath();
      if (!path.includes(root) && !(trigger?.current && path.includes(trigger.current))) dismiss();
    };
    const another = (event: Event) => {
      if ((event as CustomEvent).detail !== identity.current) dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); dismiss(true); return;
      }
      if (!(event.target instanceof Element) || !root.contains(event.target) ||
          event.target.matches('input, select, textarea, [contenteditable="true"]')) return;
      const items = controls(root);
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
        ['ArrowDown', 'ArrowRight'].includes(event.key) ? (index + 1) % items.length :
        ['ArrowUp', 'ArrowLeft'].includes(event.key) ? (index - 1 + items.length) % items.length : -1;
      if (next < 0 || !items.length) return;
      event.preventDefault(); event.stopImmediatePropagation(); items[next]?.focus();
    };
    document.addEventListener(OPEN_EVENT, another);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    // Capture before canvas keyboard handlers can interpret menu navigation.
    document.addEventListener('keydown', key, true);
    return () => {
      delete root.dataset.popover;
      document.removeEventListener(OPEN_EVENT, another);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', key, true);
    };
  }, [open, panel, trigger, contentKey]);
}

/** Give native details menus the same dismissal and keyboard behavior. */
export function useDetailsPopover(ref: RefObject<HTMLDetailsElement>) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement>(null);
  useEffect(() => {
    const details = ref.current;
    if (!details) return;
    (panel as { current: HTMLElement | null }).current = details.querySelector<HTMLElement>(':scope > :not(summary)');
    (trigger as { current: HTMLElement | null }).current = details.querySelector('summary');
    const toggle = () => setOpen(details.open);
    const key = (event: KeyboardEvent) => {
      if (event.target === trigger.current && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); details.open = true; setOpen(true);
      }
    };
    details.addEventListener('toggle', toggle);
    details.addEventListener('keydown', key);
    return () => { details.removeEventListener('toggle', toggle); details.removeEventListener('keydown', key); };
  }, [ref]);
  usePopover(panel, open, () => { if (ref.current) ref.current.open = false; setOpen(false); }, trigger);
}
