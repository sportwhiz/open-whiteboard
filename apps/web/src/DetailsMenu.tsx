import { useEffect, useRef, type ReactNode } from 'react';
import { useDetailsPopover } from './usePopover';

/**
 * A native details menu that closes after an item is chosen. Focus returns to
 * the menu button; an action that opens a dialog then moves focus into it, and
 * the dialog restores focus to the menu button when it closes.
 *
 * `floating` positions the menu against the viewport, for menus inside a
 * scrolling list that would otherwise clip them. It follows its button while
 * the list scrolls or reflows, and closes once the button scrolls out of view.
 */
export function DetailsMenu({ children, className, floating = false }: { children: ReactNode; className: string; floating?: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useDetailsPopover(ref);
  useEffect(() => {
    const details = ref.current;
    if (!floating || !details) return;
    const summary = details.querySelector<HTMLElement>(':scope > summary');
    const menu = details.querySelector<HTMLElement>(':scope > :not(summary)');
    if (!summary || !menu) return;
    let frame = 0;
    const place = () => {
      const anchor = summary.getBoundingClientRect();
      // Follow the button while it stays on screen (scrolling, or the list
      // reflowing when data refreshes); close once it scrolls out of view.
      if (anchor.bottom < 0 || anchor.top > innerHeight || anchor.width === 0) { details.open = false; return; }
      menu.style.position = 'fixed';
      menu.style.right = 'auto';
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const below = anchor.bottom + 4 + height <= innerHeight - 8;
      menu.style.top = `${below ? anchor.bottom + 4 : Math.max(8, anchor.top - 4 - height)}px`;
      menu.style.left = `${Math.min(innerWidth - width - 8, Math.max(8, anchor.right - width))}px`;
    };
    // One cheap measurement per frame, only while this menu is open.
    const follow = () => {
      if (!details.open) return;
      place();
      frame = requestAnimationFrame(follow);
    };
    const toggle = () => {
      cancelAnimationFrame(frame);
      if (details.open) follow();
    };
    details.addEventListener('toggle', toggle);
    return () => {
      cancelAnimationFrame(frame);
      details.removeEventListener('toggle', toggle);
    };
  }, [floating]);
  return <details ref={ref} className={className} onClick={event => {
    const details = ref.current;
    const item = (event.target as Element).closest('button, [data-menu-item]');
    if (!details || !item || item.closest('summary')) return;
    details.open = false;
    details.querySelector<HTMLElement>(':scope > summary')?.focus({ preventScroll: true });
  }}>{children}</details>;
}
