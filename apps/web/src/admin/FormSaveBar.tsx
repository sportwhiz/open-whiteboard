import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { navigateTo } from '../app-navigation';
import { useDialogFocus } from '../useDialogFocus';
import { UiIcon } from '../UiIcon';
import { saveBarMessage, shouldGuardLink } from './form-state';

type Guard = (href: string) => void;
let activeGuard: Guard | null = null;

/**
 * Navigate within the app, asking first when a settings form has unsaved
 * changes. Use for programmatic navigation (menus, search results).
 */
export function requestNavigation(href: string) {
  if (activeGuard) activeGuard(href);
  else navigateTo(href);
}

/**
 * The save bar for a settings form. It owns the form's save state: unsaved
 * changes, saving, the result of the last save (shown here, next to the
 * button, rather than at the top of the page), and the leave guard.
 */
export function FormSaveBar({ dirty, busy, label, onDiscard, error = '', notice = '', onClearFeedback }: {
  dirty: boolean;
  busy: boolean;
  label: string;
  onDiscard: () => void;
  /** Error from the last save of this form. */
  error?: string;
  /** Success message from the last save of this form. */
  notice?: string;
  /** Clear a stale result once the form changes again. */
  onClearFeedback?: () => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const discard = useRef(onDiscard);
  discard.current = onDiscard;
  const [leaving, setLeaving] = useState<string | null>(null);
  const [discarded, setDiscarded] = useState(false);
  const allowLeave = useRef(false);
  useDialogFocus(dialogRef, leaving !== null, () => setLeaving(null));

  // "Changes saved." must not sit above "You have unsaved changes".
  const clear = useRef(onClearFeedback);
  clear.current = onClearFeedback;
  useEffect(() => {
    if (dirty && notice) clear.current?.();
    if (dirty) setDiscarded(false);
  }, [dirty, notice]);

  // A failed save moves focus to the field it is about, when the form marks one.
  useEffect(() => {
    if (!error) return;
    const invalid = barRef.current?.closest('form')?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (invalid) { invalid.focus(); invalid.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }, [error]);

  // Saving an unchanged form, or a second save while one runs, does nothing.
  useEffect(() => {
    const form = barRef.current?.closest('form');
    if (!form) return;
    const block = (event: Event) => {
      if (dirty && !busy) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    form.addEventListener('submit', block, true);
    return () => form.removeEventListener('submit', block, true);
  }, [dirty, busy]);

  useEffect(() => {
    if (!dirty) return;
    allowLeave.current = false;
    const warn = (event: BeforeUnloadEvent) => {
      if (!allowLeave.current) { event.preventDefault(); event.returnValue = ''; }
    };
    // Every in-app link gets the same confirmation, whether it is handled by
    // client-side navigation or a full page load.
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!link || !shouldGuardLink(link, location.href)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setLeaving(link.href);
    };
    const guard: Guard = href => setLeaving(href);
    activeGuard = guard;
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', click, true);
    return () => {
      if (activeGuard === guard) activeGuard = null;
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', click, true);
    };
  }, [dirty]);

  // The Discard button disappears with the changes; continue in the form.
  const focusFirstField = () => {
    const form = barRef.current?.closest('form');
    const field = form?.querySelector<HTMLElement>('input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)');
    (field ?? barRef.current?.querySelector<HTMLElement>('button[type="submit"]'))?.focus();
  };
  const leave = () => {
    const href = leaving;
    if (!href) return;
    allowLeave.current = true;
    setLeaving(null);
    discard.current();
    navigateTo(href);
  };

  const message = saveBarMessage({ dirty, busy, error, notice, discarded });
  // The bar sits at the end of its form. On long pages, while there is
  // something to save or read, it floats at the bottom of the window.
  const slotRef = useRef<HTMLDivElement>(null);
  const [offscreen, setOffscreen] = useState(false);
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(([entry]) => setOffscreen(!entry.isIntersecting), { threshold: 1 });
    observer.observe(slot);
    return () => observer.disconnect();
  }, []);
  const floating = offscreen && ['dirty', 'error', 'busy', 'saved'].includes(message.tone);
  return <div ref={slotRef} className="settings-save-slot" style={floating ? { minHeight: barRef.current?.offsetHeight } : undefined}><div ref={barRef} className={`settings-save-bar ${message.tone} ${floating ? 'floating' : ''}`}>
    <div className="settings-save-status">
      {message.tone === 'error' ? <span className="save-state-icon" aria-hidden="true">!</span> : message.tone === 'saved' ? <UiIcon name="check" className="save-state-icon" /> : message.tone === 'dirty' ? <span className="save-state-dot" aria-hidden="true" /> : null}
      <span role="status">{message.tone === 'error' ? '' : message.text}</span>
      <span role="alert">{message.tone === 'error' ? message.text : ''}</span>
    </div>
    {dirty ? <button type="button" aria-disabled={busy} onClick={() => { if (busy) return; discard.current(); setDiscarded(true); clear.current?.(); focusFirstField(); }}>Discard</button> : null}
    <button type="submit" className="identity-primary" aria-disabled={busy || !dirty} aria-busy={busy} onClick={event => { if (busy || !dirty) event.preventDefault(); }}>{busy ? 'Saving…' : label}</button>
    {leaving !== null ? createPortal(<div className="leave-confirm-backdrop">
      <div ref={dialogRef} className="leave-confirm" role="alertdialog" aria-modal="true" aria-labelledby="leave-confirm-title" aria-describedby="leave-confirm-description">
        <h2 id="leave-confirm-title">Discard unsaved changes?</h2>
        <p id="leave-confirm-description">Your changes on this page have not been saved. If you leave now, they will be lost.</p>
        <div className="leave-confirm-actions">
          <button type="button" className="identity-primary" onClick={() => setLeaving(null)}>Keep editing</button>
          <button type="button" className="identity-danger" onClick={leave}>Discard and leave</button>
        </div>
      </div>
    </div>, document.body) : null}
  </div></div>;
}
