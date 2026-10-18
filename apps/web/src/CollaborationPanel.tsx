import { apiFetch } from "./auth-client";
import { UiIcon, type UiIconName } from "./UiIcon";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { PublicCollaborationState } from './room-collaboration';
import { avatarInk } from './avatar-color';
import { formatTimer, timerSoundEnabled } from './board-timer';
import { useCountdown } from './useCountdown';
import { holdsUnsentText, threadLink, useBoardDraft } from './collaboration-drafts';
import { focusOrFallback } from './usePopover';
import { shouldRescueFocus, visibleCanvasCentre, whenCanvasReady } from './panel-focus';
import { useCollaborationCommands } from './collaboration-commands';
import { facilitation } from './facilitation';
import { WorkshopBrainstorm } from './WorkshopBrainstorm';
import { WorkshopVoting } from './WorkshopVoting';
import { CommentThreadCard } from './CommentThread';
import { mentionedIds, useMentionPicker, type MentionPerson } from './MentionPicker';
import { anchorLabel, describeAnchor, objectAt, quote, eligibleVoterIds, uniqueParticipants, type Anchor, type SemanticBoard } from './collaboration-labels';


type PanelTab = 'comments' | 'workshop' | 'present' | 'activity' | 'people';
type WorkshopView = 'overview' | 'timer' | 'brainstorm' | 'voting' | 'signals';
type Area = { x: number; y: number; width: number; height: number };

const PANEL_COPY: Record<PanelTab, { title: string; description: string }> = {
  comments: { title: 'Comments', description: 'Discuss ideas and pin feedback to the canvas.' },
  workshop: { title: 'Workshop', description: 'Run a timer, collect ideas, and vote as a group.' },
  present: { title: 'Present', description: 'Lead everyone through the story on your board.' },
  activity: { title: 'Activity', description: 'Review checkpoints and recent collaboration.' },
  people: { title: 'People', description: 'See who is here and follow their view.' },
};
const WORKSHOP_COPY: Record<Exclude<WorkshopView, 'overview'>, { title: string; description: string }> = {
  timer: { title: 'Timer', description: 'Set a pace for your session.' },
  brainstorm: { title: 'Private brainstorming', description: 'Write privately, then reveal ideas together.' },
  voting: { title: 'Voting', description: 'Choose the ideas to take forward.' },
  signals: { title: 'Reactions and hands', description: 'React to an idea or raise your hand.' },
};
const REACTIONS = [
  { emoji: '👍', label: 'Thumbs up' }, { emoji: '❤️', label: 'Love' }, { emoji: '🎉', label: 'Celebrate' },
  { emoji: '👏', label: 'Applause' }, { emoji: '💡', label: 'Idea' }, { emoji: '❓', label: 'Question' },
];
const enabledControls = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>(
  'button:not(:disabled):not([aria-disabled="true"]), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]',
)).filter(item => item.getClientRects().length > 0);

export function CollaborationPanel({ boardId, state, tab, viewRequest, onViewRequestHandled, threadRequest, onThreadRequestHandled, followingUserId, mentionThreads, onMentionSeen, onClose }: {
  boardId: string;
  state: PublicCollaborationState;
  tab: PanelTab;
  viewRequest?: { view: WorkshopView; nonce: number } | null;
  onViewRequestHandled?: () => void;
  threadRequest?: { threadId: string; nonce: number } | null;
  onThreadRequestHandled?: () => void;
  followingUserId?: string | null;
  /** Threads that mention you and are unread. */
  mentionThreads?: string[];
  onMentionSeen?: (threadId: string) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const lastFocus = useRef<{ element: HTMLElement; group: string | null; scope: string | null } | null>(null);
  const [announcement, setAnnouncementText] = useState('');
  // Clear first so a repeated message ("Reply sent.") is announced again.
  const setAnnouncement = useCallback((text: string) => {
    setAnnouncementText('');
    window.setTimeout(() => setAnnouncementText(text), 60);
  }, []);
  const [workshopView, setWorkshopView] = useState<WorkshopView>(() => viewRequest?.view ?? 'overview');
  const [commentFilter, setCommentFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [comment, setComment] = useBoardDraft(boardId, 'comment', '');
  const [commentAnchor, setCommentAnchor] = useBoardDraft<Anchor | null>(boardId, 'comment-anchor', null);
  const [replies, setReplies] = useBoardDraft<Record<string, string>>(boardId, 'replies', {});
  const [editingReply, setEditingReply] = useState<{ threadId: string; replyId: string; body: string } | null>(null);
  const [placingComment, setPlacingComment] = useState(false);
  const [activeThread, setActiveThread] = useState<string | null>(() => new URLSearchParams(location.search).get('thread'));
  const [mutedThreads, setMutedThreads] = useState<string[]>([]);
  const [boardPeople, setBoardPeople] = useState<MentionPerson[]>([]);
  const [semantic, setSemantic] = useState<SemanticBoard>({ notes: [], frames: [] });
  const [timerMinutes, setTimerMinutes] = useState(5);
  const [timerLabel, setTimerLabel] = useState('');
  const [confirmTakeOver, setConfirmTakeOver] = useState(false);
  const takeOverRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmTakeOver) takeOverRef.current?.focus({ preventScroll: true }); }, [confirmTakeOver]);
  const [timerSound, setTimerSound] = useState(timerSoundEnabled);
  const [checkpointLabel, setCheckpointLabel] = useState('');
  const endpoint = `/api/v1/boards/${encodeURIComponent(boardId)}`;
  const timerSeconds = useCountdown(state.timer);

  const { command, pending, error, setError } = useCollaborationCommands(boardId, state);
  const role = facilitation(state);
  const leads = role.leads;

  // Restore focus to whatever opened the panel. A menu item that has since
  // closed with its menu falls back to the menu button.
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    return () => {
      const active = document.activeElement;
      if (active === document.body || active === null || panelRef.current?.contains(active)) focusOrFallback(trigger);
    };
  }, []);
  useEffect(() => {
    if (tab === 'comments' && (threadRequest || new URLSearchParams(location.search).has('thread'))) return;
    headingRef.current?.focus({ preventScroll: true });
  }, [tab, workshopView]);

  // Never strand keyboard users on the page body when the control they used
  // disappears or becomes disabled (a vote limit, a remote "End vote", a
  // resolved thread). It never moves focus that someone moved elsewhere.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const remember = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      lastFocus.current = target && panel.contains(target)
        ? { element: target, group: target.closest<HTMLElement>('[data-focus-group]')?.dataset.focusGroup ?? null, scope: target.closest<HTMLElement>('[data-focus-scope]')?.dataset.focusScope ?? null }
        : null;
    };
    // A click anywhere outside the panel (the canvas, its toolbars) is a
    // deliberate move; a click on panel background lets go of focus too.
    const pointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || !panel.contains(target) || !target.closest('button, input, textarea, select, a[href], [tabindex]')) lastFocus.current = null;
    };
    let frame = 0;
    const rescue = () => {
      cancelAnimationFrame(frame);
      // Browsers move focus off a disabled control a frame later; check again then.
      rescueFocus();
      frame = requestAnimationFrame(rescueFocus);
    };
    // Only DOM changes inside the panel can remove or disable its controls.
    const changes = new MutationObserver(rescue);
    changes.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
    document.addEventListener('focusin', remember);
    document.addEventListener('pointerdown', pointer, true);
    return () => {
      cancelAnimationFrame(frame);
      changes.disconnect();
      document.removeEventListener('focusin', remember);
      document.removeEventListener('pointerdown', pointer, true);
    };
  }, []);
  const rescueFocus = useCallback(() => {
    const panel = panelRef.current;
    const lost = lastFocus.current;
    if (!panel || !lost) return;
    const active = document.activeElement;
    if (!shouldRescueFocus({
      lostConnected: lost.element.isConnected && panel.contains(lost.element),
      lostDisabled: lost.element.matches(':disabled, [aria-disabled="true"]') || !lost.element.getClientRects().length,
      activeIsBody: !active || active === document.body,
      activeIsLost: active === lost.element,
    })) return;
    const byData = (name: string, value: string | null) => value ? panel.querySelector<HTMLElement>(`[data-${name}="${CSS.escape(value)}"]`) : null;
    const group = byData('focus-group', lost.group);
    const scope = byData('focus-scope', lost.scope);
    const target = group && enabledControls(group)[0] ? enabledControls(group)[0]
      : scope ? (scope.querySelector<HTMLElement>('[data-landing]') ?? (scope.hasAttribute('data-landing-heading') ? null : enabledControls(scope)[0]) ?? null)
      : null;
    (target ?? headingRef.current)?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!viewRequest) return;
    setWorkshopView(viewRequest.view);
    onViewRequestHandled?.();
  }, [viewRequest, onViewRequestHandled]);

  useEffect(() => {
    if (tab !== 'workshop' && tab !== 'present' && tab !== 'comments') return;
    const abort = new AbortController();
    void apiFetch(`${endpoint}/semantic`, { signal: abort.signal }).then(response => response.json()).then((result: { board?: SemanticBoard }) => setSemantic(result.board ?? { notes: [], frames: [] })).catch(() => undefined);
    return () => abort.abort();
  }, [boardId, tab, workshopView, tab === 'comments' ? state.comments.length : 0, state.brainstorm?.status]);
  useEffect(() => {
    if (tab !== 'comments') return;
    // Everyone who can open the board, for @mentions (online or not).
    void apiFetch(`${endpoint}/people`).then(response => response.ok ? response.json() : { people: [] }).then((value: { people?: MentionPerson[] }) => setBoardPeople(value.people ?? [])).catch(() => undefined);
    void apiFetch(`${endpoint}/comment-preferences`).then(response => response.json()).then((value: { mutedThreadIds?: string[] }) => setMutedThreads(value.mutedThreadIds ?? [])).catch(() => undefined);
  }, [boardId, tab]);

  // Comment placement: after the canvas click, typing should go to the
  // comment, not into the sticky that the same click selected.
  useEffect(() => {
    let cancelFocus: (() => void) | undefined;
    const positioned = (event: Event) => {
      setCommentAnchor((event as CustomEvent<Anchor>).detail);
      setPlacingComment(false);
      cancelFocus?.();
      const focus = () => { cancelFocus?.(); requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true })); };
      const fallback = window.setTimeout(focus, 400);
      window.addEventListener('pointerup', focus, { once: true });
      cancelFocus = () => { window.clearTimeout(fallback); window.removeEventListener('pointerup', focus); cancelFocus = undefined; };
    };
    window.addEventListener('whiteboard-comment-position', positioned);
    return () => { cancelFocus?.(); window.removeEventListener('whiteboard-comment-position', positioned); };
  }, [setCommentAnchor]);

  // Thread selection is shared with the canvas: pins highlight the selected
  // thread, and the URL can be copied while the panel is open.
  const highlight = useCallback((threadId: string | null) => {
    window.dispatchEvent(new CustomEvent('whiteboard-highlight-thread', { detail: { threadId } }));
  }, []);
  const selectThread = useCallback((threadId: string, options: { pan?: boolean; focus?: boolean } = {}) => {
    const thread = state.comments.find(item => item.id === threadId);
    if (!thread) return false;
    setActiveThread(threadId);
    highlight(threadId);
    const url = new URL(location.href);
    url.searchParams.set('thread', threadId);
    history.replaceState(history.state, '', url);
    setCommentFilter(filter => thread.resolvedAt ? (filter === 'open' ? 'all' : filter) : (filter === 'resolved' ? 'all' : filter));
    if (options.pan) window.dispatchEvent(new CustomEvent('whiteboard-focus-anchor', { detail: thread.anchor }));
    window.setTimeout(() => {
      const article = document.getElementById(threadId);
      article?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (options.focus) article?.focus({ preventScroll: true });
    }, 60);
    return true;
  }, [state.comments, highlight]);
  useEffect(() => {
    if (tab !== 'comments') return;
    const requested = threadRequest?.threadId ?? new URLSearchParams(location.search).get('thread');
    if (!requested) return;
    if (!selectThread(requested, { focus: true })) return;
    onThreadRequestHandled?.();
    onMentionSeen?.(requested);
    // A deep link can arrive before the canvas has loaded and fitted the
    // board; pan to the thread and light up its pin once the canvas answers.
    const thread = state.comments.find(item => item.id === requested);
    return whenCanvasReady(() => {
      if (thread) window.dispatchEvent(new CustomEvent('whiteboard-focus-anchor', { detail: thread.anchor }));
      highlight(requested);
    });
  }, [tab, threadRequest?.nonce, state.comments.length > 0]);
  useEffect(() => {
    if (tab !== 'comments') return;
    return () => {
      highlight(null);
      // A closed panel must not reopen on reload.
      const url = new URL(location.href);
      if (url.searchParams.has('thread')) { url.searchParams.delete('thread'); history.replaceState(history.state, '', url); }
    };
  }, [tab, highlight]);

  const panelCopy = tab === 'workshop' && workshopView !== 'overview' ? WORKSHOP_COPY[workshopView]
    : tab === 'workshop' && !leads ? { title: 'Workshop', description: 'Join the timer, brainstorm and vote with your group.' }
    : PANEL_COPY[tab];
  const runningVote = state.voteRounds.find(round => round.status === 'running');
  const latestVote = state.voteRounds[0];
  const brainstorm = state.brainstorm;
  const people = useMemo(() => uniqueParticipants(state.participants), [state.participants]);
  // Guest URLs carry their access token; guests never get a shareable thread link.
  const isGuest = state.currentUserId.startsWith('guest:');
  const presentation = state.presentation;
  const isPresenter = presentation?.presenterId === state.currentUserId || (presentation?.status === 'running' && state.capabilities.manage);
  const raised = useMemo(() => Object.entries(state.raisedHands).sort((a, b) => a[1].localeCompare(b[1])), [state.raisedHands]);
  const nameOf = (userId: string) => userId === state.currentUserId ? 'You' : people.find(item => item.id === userId)?.name ?? 'Participant';
  const timerText = formatTimer(timerSeconds);
  const visibleThreads = state.comments.filter(thread => commentFilter === 'all' || Boolean(thread.resolvedAt) === (commentFilter === 'resolved'));

  // People to mention: everyone with access (from the server), plus anyone
  // online who is not in that list (guests see only who is online).
  const mentionPeople = useMemo(() => {
    const byId = new Map(boardPeople.map(person => [person.id, person]));
    for (const person of uniqueParticipants(state.participants)) if (!person.guest && !byId.has(person.id)) byId.set(person.id, { id: person.id, name: person.name, color: person.color });
    return [...byId.values()].filter(person => person.id !== state.currentUserId);
  }, [boardPeople, state.participants, state.currentUserId]);
  const mentionsFor = (text: string) => mentionedIds(text, mentionPeople);
  const composerMentions = useMentionPicker({ value: comment, onValue: setComment, people: mentionPeople, field: composerRef });
  const addComment = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!comment.trim()) return;
    // A pinned comment is attached to the object under its pin. An unpinned
    // comment belongs to the board, at the place its author was looking.
    const view = visibleCanvasCentre(state.participants.find(person => person.id === state.currentUserId && person.viewport)?.viewport);
    const anchor = commentAnchor
      ? { ...commentAnchor, objectId: commentAnchor.objectId ?? objectAt(commentAnchor, semantic) }
      : { x: Math.round(view?.x ?? 120), y: Math.round(view?.y ?? 120), objectId: null };
    const result = await command('add_comment', { body: comment, mentions: mentionsFor(comment), ...anchor });
    if (!result) return;
    setComment(''); setCommentAnchor(null); setCommentFilter(filter => filter === 'resolved' ? 'open' : filter);
    // Your new thread opens, ready for follow-up or to resolve.
    const created = result.state?.comments[0];
    if (created) { setActiveThread(created.id); highlight(created.id); }
    setAnnouncement('Comment added.');
    composerRef.current?.focus({ preventScroll: true });
  };
  const submitOnModifierEnter = (submit: () => void) => (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
  };
  const showArea = (area: Area, objectId: string | null = null) => {
    window.dispatchEvent(new CustomEvent('whiteboard-focus-anchor', { detail: { x: area.x + area.width / 2, y: area.y + area.height / 2, objectId } }));
  };
  const toggleThread = async (threadId: string, resolved: boolean) => {
    const index = visibleThreads.findIndex(item => item.id === threadId);
    const neighbor = visibleThreads[index + 1] ?? visibleThreads[index - 1];
    if (!await command(resolved ? 'reopen_comment' : 'resolve_comment', { threadId })) return;
    setAnnouncement(resolved ? 'Thread reopened.' : 'Thread resolved.');
    requestAnimationFrame(() => {
      if (document.getElementById(threadId)) return;
      const next = neighbor ? document.getElementById(neighbor.id) : null;
      (next ?? composerRef.current ?? headingRef.current)?.focus({ preventScroll: true });
      if (activeThread === threadId) { setActiveThread(null); highlight(null); }
    });
  };
  // Escape with unsent text keeps the panel open and the text intact; a
  // second Escape (now from the panel heading) closes the panel.
  const keepUnsentText = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (editingReply && event.target instanceof HTMLInputElement && event.target.closest('.reply-editor')) {
      event.preventDefault();
      const replyId = editingReply.replyId;
      setEditingReply(null);
      requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(`[data-reply-edit="${CSS.escape(replyId)}"]`)?.focus());
      return;
    }
    if (holdsUnsentText(event.target)) {
      event.preventDefault();
      headingRef.current?.focus({ preventScroll: true });
      setAnnouncement('Your draft is kept. Press Escape again to close the panel.');
    }
  };

  // Editors who are not running the session can take over deliberately.
  const facilitatorName = role.facilitatorId ? nameOf(role.facilitatorId) : 'Someone';
  const takeOver = role.canTakeOver ? <div className="take-over" data-focus-group="take-over">
    {confirmTakeOver ? <>
      <span>Take over from {facilitatorName}? You will see the facilitator controls; they will not.</span>
      <span className="button-row"><button type="button" className="primary-panel-action" ref={takeOverRef} onClick={() => void command('take_facilitation').then(result => { setConfirmTakeOver(false); if (result) setAnnouncement('You are now facilitating.'); })}>Take over</button><button type="button" onClick={() => setConfirmTakeOver(false)}>Cancel</button></span>
    </> : <>
      <span>{facilitatorName} is facilitating.</span>
      <button type="button" className="text-action" onClick={() => setConfirmTakeOver(true)}>Take over facilitation</button>
    </>}
  </div> : null;

  const workshopCards: { id: Exclude<WorkshopView, 'overview'>; title: string; description: string; icon: UiIconName; status?: string; live?: boolean }[] = [
    { id: 'timer', title: 'Timer', description: 'Set a pace and keep a session on track.', icon: 'clock', live: state.timer?.status === 'running' && timerSeconds > 0,
      status: state.timer && state.timer.status !== 'ended' && timerSeconds > 0 ? `${timerText} ${state.timer.status === 'paused' ? '· paused' : 'left'}` : undefined },
    { id: 'brainstorm', title: 'Private brainstorming', description: 'Collect individual ideas, then reveal together.', icon: 'notes', live: brainstorm?.status === 'running',
      status: brainstorm?.status === 'running' ? `Collecting · ${brainstorm.submittedCount} ${brainstorm.submittedCount === 1 ? 'idea' : 'ideas'} submitted`
        : brainstorm?.status === 'closed' ? `Closed · ${brainstorm.submittedCount} ready to reveal` : undefined },
    { id: 'voting', title: 'Voting', description: 'Find the ideas your group wants to explore.', icon: 'vote', live: Boolean(runningVote),
      status: runningVote ? `Voting open · ${Math.max(0, runningVote.votesPerUser - runningVote.myVotes.length)} of ${runningVote.votesPerUser} votes left` : latestVote?.status === 'ended' ? 'Results ready' : undefined },
    { id: 'signals', title: 'Reactions and hands', description: 'React in the moment or raise your hand.', icon: 'hand', live: raised.length > 0,
      status: raised.length ? `${raised.length} ${raised.length === 1 ? 'hand' : 'hands'} raised` : undefined },
  ];

  const handsList = raised.length ? <ol className="hands-list" data-focus-scope="hands">{raised.map(([userId, raisedAt]) => <li key={userId} data-focus-group={`hand:${userId}`}>
    <span className="hand-mark" aria-hidden="true">✋</span>
    <span className="hand-person"><strong>{nameOf(userId)}</strong><small>Raised at {new Date(raisedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></span>
    {userId === state.currentUserId ? <button type="button" onClick={() => void command('lower_hand')}>Lower</button>
      : leads ? <button type="button" aria-label={`Acknowledge ${nameOf(userId)}`} onClick={() => void command('lower_hand', { userId })}>Acknowledge</button> : null}
  </li>)}</ol> : null;

  return (
    <aside ref={panelRef} className="collaboration-panel" aria-label="Collaboration tools" aria-busy={pending} onKeyDown={keepUnsentText}>
      <header className="panel-heading"><div><h2 ref={headingRef} tabIndex={-1}>{panelCopy.title}</h2><p>{panelCopy.description}</p></div><button className="panel-close" type="button" aria-label="Close panel" onClick={onClose}><UiIcon name="close" /></button></header>
      {error ? <p className="panel-error" role="alert">{error}</p> : null}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

      <div className="panel-controls">
      {tab === 'comments' ? <div className="panel-scroll" data-focus-scope="comments">
        <div className="comment-filters" role="group" aria-label="Filter comments">{(['open', 'resolved', 'all'] as const).map(filter => <button type="button" key={filter} aria-pressed={commentFilter === filter} onClick={() => setCommentFilter(filter)}>{filter === 'open' ? 'Open' : filter === 'resolved' ? 'Resolved' : 'All'} <span>{state.comments.filter(thread => filter === 'all' || Boolean(thread.resolvedAt) === (filter === 'resolved')).length}</span></button>)}</div>
        {state.capabilities.comment ? <form className="comment-composer" onSubmit={event => void addComment(event)}>
          <div className="mention-field">
            <textarea ref={composerRef} data-landing data-draft value={comment} {...composerMentions.fieldProps} onChange={composerMentions.onChange} onKeyDown={event => { if (!composerMentions.onKeyDown(event)) submitOnModifierEnter(() => void addComment())(event); }} aria-label="Comment" aria-describedby="comment-anchor-label" placeholder="Add a comment… Type @ to mention someone." />
            {composerMentions.list}
          </div>
          <p className={`comment-anchor ${commentAnchor || placingComment ? 'pinned' : ''}`} id="comment-anchor-label"><UiIcon name="comment" />{placingComment ? 'Click anything on the canvas to pin this comment' : commentAnchor ? describeAnchor(commentAnchor, semantic) : 'Not pinned · it will be a board comment where you are looking'}</p>
          <div className="button-row">
            <button type="button" className={placingComment ? 'active' : ''} aria-pressed={placingComment} onClick={() => { setPlacingComment(true); window.dispatchEvent(new Event('whiteboard-place-comment')); }}>{placingComment ? 'Click the canvas…' : commentAnchor ? 'Move pin' : 'Pin to canvas'}</button>
            <button type="submit" disabled={!comment.trim()} title="Comment (⌘ or Ctrl + Enter)">Comment</button>
          </div>
        </form> : <p className="panel-empty">Your role can read comments.</p>}
        <div className="comment-list">{visibleThreads.map(thread => <CommentThreadCard key={thread.id} thread={thread} state={state} semantic={semantic}
          expanded={activeThread === thread.id} mentioned={Boolean(mentionThreads?.includes(thread.id))} muted={mutedThreads.includes(thread.id)} isGuest={isGuest}
          reply={replies[thread.id] ?? ''} onReply={value => setReplies(values => ({ ...values, [thread.id]: value }))} onSent={() => setAnnouncement('Reply sent.')}
          onSelect={() => highlight(thread.id)}
          onToggle={() => { if (activeThread === thread.id) { setActiveThread(null); highlight(null); } else { selectThread(thread.id, { pan: true }); onMentionSeen?.(thread.id); } }}
          onShow={() => selectThread(thread.id, { pan: true })}
          onCopyLink={() => { selectThread(thread.id); void navigator.clipboard?.writeText(threadLink(location.href, thread.id)).then(() => setAnnouncement('Link to thread copied. It works for people with access to this board.'), () => setError('Could not copy the link.')); }}
          onMute={() => { const muted = mutedThreads.includes(thread.id); void command(muted ? 'unmute_thread' : 'mute_thread', { threadId: thread.id }).then(result => { if (result) { setMutedThreads(items => muted ? items.filter(id => id !== thread.id) : [...items, thread.id]); setAnnouncement(muted ? 'Replies unmuted.' : 'Replies muted.'); } }); }}
          onResolve={() => void toggleThread(thread.id, Boolean(thread.resolvedAt))}
          command={command}
          mentionPeople={mentionPeople}
          editing={editingReply?.threadId === thread.id ? editingReply : null}
          onEdit={value => setEditingReply(value ? { threadId: thread.id, ...value } : null)}
        />)}</div>
        {!visibleThreads.length ? <div className="panel-empty-state"><span><UiIcon name="comment" /></span><strong>{commentFilter === 'resolved' ? 'No resolved comments' : commentFilter === 'all' ? 'No comments yet' : 'No open comments'}</strong><p>{commentFilter === 'resolved' ? 'Resolved conversations will appear here.' : 'Pin feedback to the canvas or start a conversation.'}</p></div> : null}
      </div> : null}

      {tab === 'workshop' ? <div className="panel-scroll workshop-panel" data-view={workshopView}>
        {workshopView === 'overview' ? <>
          <div className="workshop-summary" aria-label="Session status">
            <span><span className="online-dot" aria-hidden="true" />{people.length} {people.length === 1 ? 'person' : 'people'} here</span>
            {raised.length ? <span className="hands-chip">✋ {raised.length} {raised.length === 1 ? 'hand' : 'hands'} raised</span> : null}
          </div>
          {raised.length ? <section className="workshop-hands" aria-labelledby="workshop-hands-heading"><h3 id="workshop-hands-heading">Raised hands</h3>{handsList}</section> : null}
          <div className="facilitation-cards">{workshopCards.map(tool => <button type="button" key={tool.id} className="facilitation-card" onClick={() => setWorkshopView(tool.id)}>
            <span className="facilitation-icon" aria-hidden="true"><UiIcon name={tool.icon} /></span>
            <span className="facilitation-copy"><strong>{tool.title}</strong><small>{tool.description}</small>{tool.status ? <em className={tool.live ? (tool.id === 'signals' ? 'live hands' : 'live') : ''}>{tool.status}</em> : null}</span>
            <UiIcon name="chevron" className="facilitation-chevron" />
          </button>)}</div>
        </> : <button className="facilitation-back" type="button" onClick={() => setWorkshopView('overview')}><UiIcon name="back" />All tools</button>}

        <section className="facilitation-detail timer-detail" data-focus-scope="timer" data-landing-heading={state.timer && state.timer.status !== 'ended' && timerSeconds > 0 ? undefined : ''}><h3>Timer</h3>
          {state.timer && state.timer.status !== 'ended' && timerSeconds > 0 ? <>
            <div className="big-timer" role="timer" aria-live="off">{timerText}</div>
            <p className="timer-caption">{state.timer.status === 'paused' ? 'Paused' : 'Running'} · {state.timer.label}</p>
            {leads ? <div className="button-row timer-actions">
              <button type="button" className="primary-panel-action" data-landing onClick={() => void command(state.timer?.status === 'paused' ? 'resume_timer' : 'pause_timer')}>{state.timer.status === 'paused' ? 'Resume' : 'Pause'}</button>
              <button type="button" onClick={() => void command('extend_timer', { durationSeconds: 60 })}>+1 min</button>
              <button type="button" onClick={() => void command('stop_timer')}>Stop</button>
            </div> : <><p className="panel-hint">{facilitatorName} controls this timer.</p>{takeOver}</>}
          </> : leads ? <form className="workshop-settings" onSubmit={event => { event.preventDefault(); void command('start_timer', { label: timerLabel.trim() || 'Session timer', durationSeconds: timerMinutes * 60 }); }}>
            <label><span>Name (optional)</span><input value={timerLabel} maxLength={80} placeholder="Session timer" onChange={event => setTimerLabel(event.target.value)} /></label>
            <div className="timer-preview" aria-hidden="true">{String(Math.floor(timerMinutes)).padStart(2, '0')}:00</div>
            <div className="timer-presets" role="group" aria-label="Quick timer duration">{[3, 5, 10, 15].map(minutes => <button type="button" key={minutes} aria-pressed={timerMinutes === minutes} onClick={() => setTimerMinutes(minutes)}>{minutes} min</button>)}</div>
            <label><span>Duration in minutes</span><input type="number" min={1} max={240} value={timerMinutes} onChange={event => setTimerMinutes(Number(event.target.value))} /></label>
            <button type="submit">Start timer</button>
          </form> : <><p className="panel-hint" tabIndex={-1} data-landing>No timer is running.</p>{takeOver}</>}
          <label className="privacy-toggle"><input type="checkbox" checked={timerSound} onChange={event => { setTimerSound(event.target.checked); try { localStorage.setItem('whiteboard-timer-sound', event.target.checked ? 'on' : 'off'); } catch { /* Storage is optional. */ } }} /><span>Play a sound when time ends</span></label>
        </section>

        <WorkshopBrainstorm boardId={boardId} state={state} command={command} announce={setAnnouncement} leads={leads} takeOver={takeOver} showArea={showArea} />

        <WorkshopVoting state={state} semantic={semantic} command={command} leads={leads} takeOver={takeOver} peopleCount={eligibleVoterIds(state.participants).size} />

        <section className="facilitation-detail signals-detail" data-focus-scope="signals"><h3>Reactions and hands</h3>
          <div className="reaction-row" role="group" aria-label="Send a reaction">{REACTIONS.map(reaction => <button type="button" key={reaction.emoji} aria-label={`React with ${reaction.label}`} title={reaction.label} onClick={() => void command('reaction', { emoji: reaction.emoji }).then(result => { if (result) setAnnouncement(`Sent ${reaction.label}.`); })}>{reaction.emoji}</button>)}</div>
          <button type="button" className={`hand-toggle ${state.raisedHands[state.currentUserId] ? 'raised' : ''}`} aria-pressed={Boolean(state.raisedHands[state.currentUserId])} data-landing onClick={() => void command(state.raisedHands[state.currentUserId] ? 'lower_hand' : 'raise_hand')}><span aria-hidden="true">✋</span>{state.raisedHands[state.currentUserId] ? 'Lower my hand' : 'Raise my hand'}</button>
          {raised.length ? <><h4 className="hands-heading">Raised hands · {raised.length}</h4>{handsList}</> : <p className="panel-hint">No hands raised.</p>}
        </section>
      </div> : null}

      {tab === 'present' ? <div className="panel-scroll presentation-panel" data-focus-scope="present">
        <section>
          <h3>Presentation order</h3>
          <ol className="presentation-frame-list">{semantic.frames.map((frame, index) => {
            const current = presentation?.status === 'running' && presentation.frameIds[presentation.frameIndex] === frame.id;
            const position = presentation?.status === 'running' ? presentation.frameIds.indexOf(frame.id) : -1;
            return <li key={frame.id} className={current ? 'current' : ''} aria-current={current ? 'step' : undefined}>
              <span className="presentation-frame-number">{index + 1}</span>
              {isPresenter && position >= 0 && !current ? <button type="button" className="frame-jump" onClick={() => void command('presentation_frame', { frameIndex: position })}>{frame.title || `Frame ${index + 1}`}</button> : <span>{frame.title || `Frame ${index + 1}`}</span>}
            </li>;
          })}</ol>
          {presentation?.status === 'running' ? <>
            <p className="presentation-status">Frame {presentation.frameIndex + 1} of {presentation.frameIds.length}{isPresenter ? ' · use ← and → to move' : ''}</p>
            {isPresenter ? <div className="presenter-controls">
              <button type="button" disabled={presentation.frameIndex === 0} onClick={() => void command('presentation_frame', { frameIndex: Math.max(0, presentation.frameIndex - 1) })}>Previous</button>
              <button className="primary-panel-action" type="button" disabled={presentation.frameIndex >= presentation.frameIds.length - 1} onClick={() => void command('presentation_frame', { frameIndex: Math.min(presentation.frameIds.length - 1, presentation.frameIndex + 1) })}>Next</button>
              <button type="button" onClick={() => void command('end_presentation')}>End</button>
            </div> : <p className="panel-hint">{followingUserId === presentation.presenterId ? 'You are following the presenter. Move the canvas to look around on your own.' : 'You are looking around on your own.'}</p>}
            {!isPresenter && followingUserId !== presentation.presenterId ? <button type="button" className="primary-panel-action" onClick={() => window.dispatchEvent(new CustomEvent('whiteboard-join-presentation'))}>Join presentation</button> : null}
            {isPresenter && people.length > 1 ? <label className="handoff-field"><span>Hand off to</span><select defaultValue="" onChange={event => { if (event.target.value) void command('handoff_presentation', { userId: event.target.value }); }}><option value="" disabled>Choose a person</option>{people.filter(person => person.id !== state.currentUserId).map(person => <option value={person.id} key={person.id}>{person.name}</option>)}</select></label> : null}
          </> : leads && semantic.frames.length ? <button className="primary-panel-action" type="button" data-landing onClick={() => void command('start_presentation', { frameIds: semantic.frames.map(frame => frame.id) })}>Present {semantic.frames.length} {semantic.frames.length === 1 ? 'frame' : 'frames'}</button>
            : semantic.frames.length ? <><p className="panel-hint">No presentation is running.</p>{takeOver}</> : <p className="panel-hint">Add frames to your board to create a guided presentation.</p>}
          <div className="button-row"><button type="button" onClick={() => void document.documentElement.requestFullscreen?.()}>Enter full screen</button>{leads ? <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('whiteboard-bring-everyone')); setAnnouncement('Everyone was brought to your view.'); }}>Bring everyone to me</button> : null}</div>
        </section>
        <section className="shortcut-card"><span className="keycap">⇧ L</span><div><h3>Laser pointer</h3><p>Hold Shift + L while pointing to highlight details for everyone.</p></div></section>
      </div> : null}

      {tab === 'activity' ? <div className="panel-scroll" data-focus-scope="activity"><div className="checkpoint-composer">{state.capabilities.edit ? <form className="inline-reply" onSubmit={event => { event.preventDefault(); if (!checkpointLabel.trim()) return; void command('create_checkpoint', { label: checkpointLabel }).then(result => { if (result) { setCheckpointLabel(''); setAnnouncement('Checkpoint saved.'); } }); }}><input data-draft value={checkpointLabel} onChange={event => setCheckpointLabel(event.target.value)} aria-label="Checkpoint name" placeholder="Checkpoint name" /><button type="submit" disabled={!checkpointLabel.trim()}>Save checkpoint</button></form> : null}</div>{state.checkpoints.map(item => <article className="activity-row" key={item.id}><b>{item.label}</b><span>Revision {item.revision} · {new Date(item.createdAt).toLocaleString()}</span></article>)}{state.activity.map(item => <article className="activity-row" key={item.id}><b>{item.summary}</b><span>{new Date(item.createdAt).toLocaleString()}</span></article>)}{!state.activity.length && !state.checkpoints.length ? <p className="panel-empty">Activity will appear as people collaborate.</p> : null}</div> : null}

      {tab === 'people' ? <div className="panel-scroll" data-focus-scope="people">
        <div className="panel-section-label"><span className="online-dot" />{people.length} online now{raised.length ? <span className="hands-chip">✋ {raised.length} raised</span> : null}</div>
        {leads && people.length > 1 ? <button type="button" className="bring-everyone" onClick={() => { window.dispatchEvent(new CustomEvent('whiteboard-bring-everyone')); setAnnouncement('Everyone was brought to your view.'); }}>Bring everyone to my view</button> : null}
        {people.map(person => {
          const following = followingUserId === person.id;
          return <article className={`participant-row ${following ? 'following' : ''}`} key={person.id} data-focus-group={`person:${person.id}`}>
            <span style={{ background: person.color, color: avatarInk(person.color) }} aria-hidden="true">{person.name.slice(0, 1).toUpperCase()}</span>
            <div><strong>{person.name}{state.raisedHands[person.id] ? <span className="hand-mark" title="Hand raised"> ✋<span className="sr-only">hand raised</span></span> : null}</strong><small>{person.guest ? 'Guest · ' : ''}{person.role}{person.id === state.presentation?.presenterId ? ' · presenting' : ''}{person.connections > 1 ? ` · ${person.connections} tabs` : ''}{person.idle ? ' · away' : ''}</small></div>
            {person.id === state.currentUserId ? <small className="you-label">You</small>
              : following ? <button type="button" className="follow-button following" aria-pressed="true" aria-label={`Following ${person.name}. Stop following`} onClick={() => window.dispatchEvent(new Event('whiteboard-stop-following'))}><span>Following</span><span aria-hidden="true">·</span><span>Stop</span></button>
              : <button type="button" className="follow-button" aria-pressed="false" aria-label={`Follow ${person.name}`} onClick={() => window.dispatchEvent(new CustomEvent('whiteboard-follow', { detail: { userId: person.id } }))}>Follow</button>}
          </article>;
        })}
        {people.length <= 1 ? <p className="panel-empty">No one else is here right now. Share the board to invite people.</p> : null}
      </div> : null}
      </div>
      {pending ? <div className="panel-action-status" aria-hidden="true">Updating…</div> : null}
    </aside>
  );
}

export type { PanelTab, WorkshopView };
