import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from './auth-client';
import { sendCollaborationCommand } from './collaboration-commands';
import { DetailsMenu } from './DetailsMenu';
import { runningActivities, type WorkshopActivity } from './facilitation';
import type { PublicCollaborationState } from './room-collaboration';
import { UiIcon } from './UiIcon';
import { uniqueParticipants } from './collaboration-labels';
import { canvasHasSelection, keySnapshot } from './key-snapshot';

/**
 * A quiet line under the header that tells people an activity has started
 * ("Brainstorm open · Add ideas"). It never takes focus; choosing it opens
 * the right panel view, or joins the presentation.
 */
export function ActivityPill({ state, followingUserId, hidden, onOpen }: {
  state: PublicCollaborationState;
  followingUserId: string | null;
  /** Kinds whose panel view is already open. */
  hidden: WorkshopActivity['kind'][];
  onOpen: (activity: WorkshopActivity) => void;
}) {
  const [now, setNow] = useState(Date.now);
  // Dismissal is per activity: a ticking countdown does not bring it back.
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const announced = useRef(new Set<string>());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 15_000); return () => window.clearInterval(timer); }, []);
  const all = runningActivities(state, { now, followingUserId });
  const key = (item: WorkshopActivity) => `${item.kind}:${item.id}`;
  // Announce each activity once, when it starts; never the countdown.
  useEffect(() => {
    const fresh = all.filter(item => !announced.current.has(key(item)));
    if (!fresh.length) return;
    for (const item of fresh) announced.current.add(key(item));
    setAnnouncement(fresh.map(item => `${item.label}. ${item.hint ? `${item.hint} ` : ''}${item.action}.`).join(' '));
  }, [all.map(key).join('|')]);
  const items = all.filter(item => !hidden.includes(item.kind) && !dismissed.includes(key(item)));
  return <>
    <p className="sr-only" role="status">{announcement}</p>
    {items.length ? <div className="activity-pills">
      {items.map(item => <div key={item.id} className={`activity-pill activity-${item.kind} ${item.hint ? 'with-hint' : ''}`}>
        <span className="activity-dot" aria-hidden="true" />
        <button type="button" className="activity-open" onClick={() => onOpen(item)}><span>{item.label}{item.detail ? <span className="activity-detail"> · {item.detail}</span> : null}</span><strong>{item.action}</strong></button>
        <button type="button" className="activity-dismiss" aria-label={`Hide “${item.label}”`} title="Hide" onClick={() => setDismissed(values => [...values, key(item)])}><UiIcon name="close" /></button>
        {item.hint ? <small className="activity-hint">{item.hint}</small> : null}
      </div>)}
    </div> : null}
  </>;
}

/** Whether a key event is aimed at text entry or a dialog/menu (shadow DOM included). */
const typing = (event: Event) => event.composedPath().some(node => node instanceof Element && node.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="dialog"], [role="menu"], .collaboration-panel'));

/**
 * The presenter's controls, on the board, whether or not a panel is open.
 * Page Up/Down move between frames while presenting (← → too when nothing
 * is selected on the canvas, where they would also nudge the selection), never
 * while typing. Escape never ends everyone's presentation by itself: it asks
 * first, and not when it was used to clear a selection.
 */
export function PresenterBar({ boardId, state, onError }: { boardId: string; state: PublicCollaborationState; onError: (message: string) => void }) {
  const presentation = state.presentation;
  const presenting = presentation?.status === 'running' && presentation.presenterId === state.currentUserId;
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirming) keepRef.current?.focus({ preventScroll: true }); }, [confirming]);
  useEffect(() => { if (!presenting) setConfirming(false); }, [presenting]);
  const go = useCallback((frameIndex: number) => {
    if (!presentation) return;
    const next = Math.max(0, Math.min(presentation.frameIds.length - 1, frameIndex));
    if (next === presentation.frameIndex) return;
    void sendCollaborationCommand(boardId, 'presentation_frame', { frameIndex: next }).catch(error => onError(error instanceof Error ? error.message : 'Could not change the frame.'));
  }, [boardId, presentation, onError]);
  const end = () => { setConfirming(false); void sendCollaborationCommand(boardId, 'end_presentation').catch(error => onError(error instanceof Error ? error.message : 'Could not end the presentation.')); };
  useEffect(() => {
    if (!presenting || !presentation) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || typing(event)) return;
      const page = event.key === 'PageDown' || event.key === 'PageUp';
      const arrow = event.key === 'ArrowRight' || event.key === 'ArrowLeft';
      // Decided from the state before the canvas handled the key.
      const selected = keySnapshot(event)?.hadSelection ?? canvasHasSelection();
      if (!page && !(arrow && !selected)) return;
      event.preventDefault();
      go(presentation.frameIndex + (event.key === 'ArrowRight' || event.key === 'PageDown' ? 1 : -1));
    };
    // Sent by the board page after panels, menus and following had their turn.
    // The board page passes the original key event: if the canvas had a
    // selection when Escape was pressed, that Escape was for the canvas.
    const escape = (event: Event) => {
      const original = (event as CustomEvent<{ event?: Event }>).detail?.event;
      if (keySnapshot(original)?.hadSelection ?? false) return;
      setConfirming(value => !value);
    };
    window.addEventListener('keydown', key);
    window.addEventListener('whiteboard-presenter-escape', escape);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('whiteboard-presenter-escape', escape); };
  }, [presenting, presentation, go]);
  if (!presenting || !presentation) return null;
  const others = uniqueParticipants(state.participants).filter(person => person.id !== state.currentUserId);
  const last = presentation.frameIds.length - 1;
  if (confirming) return <div className="presenter-bar confirming" role="alertdialog" aria-label="End presentation">
    <span className="presenter-question">End the presentation for everyone?</span>
    <button type="button" ref={keepRef} onClick={() => setConfirming(false)}>Keep presenting</button>
    <button type="button" className="presenter-end" onClick={end}>End presentation</button>
  </div>;
  return <div className="presenter-bar" role="toolbar" aria-label="Presenting">
    <span className="presenter-live" aria-hidden="true" />
    <button type="button" aria-label="Previous frame" title="Previous (← or Page Up)" disabled={presentation.frameIndex === 0} onClick={() => go(presentation.frameIndex - 1)}><UiIcon name="back" /></button>
    <span className="presenter-position" aria-live="polite">{presentation.frameIndex + 1} / {presentation.frameIds.length}</span>
    <button type="button" aria-label="Next frame" title="Next (→ or Page Down)" disabled={presentation.frameIndex === last} onClick={() => go(presentation.frameIndex + 1)}><UiIcon name="arrow" /></button>
    {others.length ? <DetailsMenu className="presenter-handoff">
      <summary title="Hand off the presentation">Hand off</summary>
      <div className="presenter-handoff-menu">
        {others.map(person => <button type="button" key={person.id} onClick={() => void sendCollaborationCommand(boardId, 'handoff_presentation', { userId: person.id }).catch(error => onError(error instanceof Error ? error.message : 'Could not hand off.'))}>{person.name}</button>)}
      </div>
    </DetailsMenu> : null}
    <button type="button" className="presenter-end" title="End presentation" onClick={() => setConfirming(true)}>End</button>
  </div>;
}

type Notification = { id: string; boardId: string | null; kind: string; href: string; readAt: string | null };

/** Unread @mentions on this board, by thread, so the header and panel can show them. */
export function useBoardMentions(boardId: string, enabled: boolean, revision: string) {
  const [items, setItems] = useState<{ id: string; threadId: string }[]>([]);
  // Threads opened before the notifications arrived (for example a deep link).
  const opened = useRef(new Set<string>());
  const markRead = (entries: { id: string }[]) => {
    for (const item of entries) void apiFetch(`/api/v1/notifications/${encodeURIComponent(item.id)}/read`, { method: 'POST' }).catch(() => undefined);
  };
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    void apiFetch('/api/v1/notifications', { signal: abort.signal })
      .then(response => response.ok ? response.json() : { notifications: [] })
      .then((value: { notifications?: Notification[] }) => {
        const unread = (value.notifications ?? [])
          .filter(item => item.boardId === boardId && item.kind === 'mention' && !item.readAt)
          .flatMap(item => { const threadId = new URL(item.href, location.origin).searchParams.get('thread'); return threadId ? [{ id: item.id, threadId }] : []; });
        markRead(unread.filter(item => opened.current.has(item.threadId)));
        setItems(unread.filter(item => !opened.current.has(item.threadId)));
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [boardId, enabled, revision]);
  const seen = useCallback((threadId: string) => {
    opened.current.add(threadId);
    setItems(current => {
      markRead(current.filter(entry => entry.threadId === threadId));
      return current.filter(entry => entry.threadId !== threadId);
    });
  }, []);
  return { threads: [...new Set(items.map(item => item.threadId))], seen };
}
