// Registers its key snapshot listener before the canvas mounts (see key-snapshot.ts).
import "./key-snapshot";
import { studioSessionKey } from "./studio-session";
import { focusOrFallback } from "./usePopover";
import { DetailsMenu } from "./DetailsMenu";
import { BrandMark } from "./BrandMark";
import { HistoryArt } from "./OnboardingArt";
import { BoardTimer } from "./BoardTimer";
import { PRODUCT_NAME } from "./product";
import { apiFetch } from "./auth-client";
import { UiIcon, type UiIconName } from "./UiIcon";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { CollaborationPanel, type PanelTab, type WorkshopView } from './CollaborationPanel';
import { uniqueParticipants } from './collaboration-labels';
import { ActivityPill, PresenterBar, useBoardMentions } from './BoardActivity';
import { facilitation, presenceOrder, workshopIsLive } from './facilitation';
import { sendCollaborationCommand } from './collaboration-commands';
import { Home } from './Home';
import { ThemeMenu } from './theme';
import { avatarInk } from './avatar-color';
import { loadBoardBootstrap, type BoardBootstrap } from './board-loading';
import { loadEditor, prepareEditor } from './editor-loader';
import { navigateTo, useAppLocation } from './app-navigation';
import { ShareDialog } from './ShareDialog';
import type { PublicCollaborationState } from './room-collaboration';

const EditorCanvas = lazy(() =>
  loadEditor().then(module => ({
    default: module.EditorCanvas,
  }))
);
const Settings = lazy(() => import('./Settings').then(module => ({ default: module.Settings })));
const ConnectedApps = lazy(() => import('./ConnectedApps').then(module => ({ default: module.ConnectedApps })));

function BoardIcon({ name }: { name: UiIconName }) {
  return <UiIcon name={name} className="board-icon" />;
}

/** The Studio view a board was opened from, so Back returns to the same workbook, filter or search. */
function studioReturnHref(userId?: string) {
  try {
    const value = sessionStorage.getItem(studioSessionKey('return', userId));
    return value && /^\/(?:\?[^#]*)?$/.test(value) ? value : '/';
  } catch {
    return '/';
  }
}

export function BoardPage({ boardId, guest = false }: { boardId: string; guest?: boolean }) {
  const [title, setTitle] = useState('Whiteboard');
  const [loading, setLoading] = useState<{ boardId: string; promise: Promise<BoardBootstrap> } | null>(null);
  const [workbookTitle, setWorkbookTitle] = useState('Ideas');
  const [versions, setVersions] = useState<
    { revision: number; updatedAt: string; name?: string | null }[] | null
  >(null);
  const [versionPreview, setVersionPreview] = useState<{ revision: number; notes: string[]; noteCount: number; frameCount: number; connectorCount: number } | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [collaboration, setCollaboration] = useState<PublicCollaborationState | null>(null);
  const [panel, setPanel] = useState<PanelTab | null>(() => new URLSearchParams(location.search).has('thread') ? 'comments' : null);
  const [sharing, setSharing] = useState(false);
  const [viewRequest, setViewRequest] = useState<{ view: WorkshopView; nonce: number } | null>(null);
  const consumeViewRequest = useCallback(() => setViewRequest(null), []);
  const [threadRequest, setThreadRequest] = useState<{ threadId: string; nonce: number } | null>(null);
  const consumeThreadRequest = useCallback(() => setThreadRequest(null), []);
  const [followingUserId, setFollowingUserId] = useState<string | null>(null);
  const [canCopy, setCanCopy] = useState(false);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const syncStatus = useRef({ connection, saveState });
  const historyHeadingRef = useRef<HTMLHeadingElement>(null);
  const historyTrigger = useRef<HTMLElement | null>(null);
  const updateCollaboration = useCallback((state: PublicCollaborationState) => setCollaboration(state), []);
  const updateConnection = useCallback((state: 'connecting' | 'online' | 'offline') => { syncStatus.current.connection = state; setConnection(state); }, []);
  const updateSaveState = useCallback((state: 'saved' | 'saving' | 'error') => { syncStatus.current.saveState = state; setSaveState(state); }, []);
  const closeHistory = useCallback(() => {
    setVersions(null);
    setVersionPreview(null);
    setHistoryError('');
    const active = document.activeElement;
    if (!active || active === document.body || active.closest('.history-panel')) {
      // The trigger lives in the More menu, which has closed since.
      requestAnimationFrame(() => focusOrFallback(historyTrigger.current, document.querySelector<HTMLElement>('.board-more > summary')));
    }
  }, []);
  const togglePanel = (next: PanelTab) => {
    if (versions || historyError) closeHistory();
    setPanel(current => current === next ? null : next);
  };
  const openWorkshop = (view: WorkshopView) => {
    if (versions || historyError) closeHistory();
    setPanel('workshop');
    setViewRequest({ view, nonce: Date.now() });
  };

  useEffect(() => {
    const abort = new AbortController();
    // Download the board and the editor in parallel. The header can show real
    // metadata while the larger native editor is still loading.
    const promise = loadBoardBootstrap(boardId, abort.signal);
    setLoading({ boardId, promise });
    prepareEditor();
    void promise.then(({ metadata }) => {
        if (abort.signal.aborted) return;
        setCanCopy(metadata.canCopy);
        setWorkbookTitle(metadata.workbookTitle);
        setTitle(metadata.title);
        document.title = `${metadata.title} · ${PRODUCT_NAME}`;
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setCanCopy(false);
        setWorkbookTitle('Ideas');
        setTitle('Whiteboard');
      });
    return () => abort.abort();
  }, [boardId]);

  // One Escape handler for board chrome, in priority order: history, the side
  // panel, then following. Popovers and dialogs handle Escape before this.
  // Escape never closes anything while someone is typing on the canvas, and a
  // panel field with unsent text keeps the panel open (see CollaborationPanel).
  useEffect(() => {
    const closeTransientSurface = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || sharing) return;
      const path = event.composedPath().filter((node): node is Element => node instanceof Element);
      const inPanel = path.some(node => node.matches('.collaboration-panel, .history-panel'));
      // composedPath sees into shadow DOM (frame titles, the engine's editors).
      if (!inPanel && path.some(node => node.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="dialog"]'))) return;
      if (versions || historyError) { event.preventDefault(); closeHistory(); return; }
      if (panel) { event.preventDefault(); setPanel(null); return; }
      if (followingUserId) { event.preventDefault(); window.dispatchEvent(new Event('whiteboard-stop-following')); return; }
      const presentation = collaboration?.presentation;
      // Never ends a presentation directly: the presenter bar asks first.
      if (presentation?.status === 'running' && presentation.presenterId === collaboration?.currentUserId) window.dispatchEvent(new CustomEvent('whiteboard-presenter-escape', { detail: { event } }));
    };
    window.addEventListener('keydown', closeTransientSurface);
    return () => window.removeEventListener('keydown', closeTransientSurface);
  }, [panel, sharing, versions, historyError, followingUserId, closeHistory, collaboration?.presentation, collaboration?.currentUserId, boardId]);

  // Deep links (?thread=) and canvas comment pins open the thread in the panel.
  useEffect(() => {
    const openLinkedThread = () => {
      const threadId = new URLSearchParams(location.search).get('thread');
      if (!threadId) return;
      // Close history entirely (also when it only shows a load error), so
      // the comments panel is not hidden behind it.
      setVersions(null);
      setVersionPreview(null);
      setHistoryError('');
      setPanel('comments');
      setThreadRequest({ threadId, nonce: Date.now() });
    };
    const openThread = (event: Event) => {
      const threadId = (event as CustomEvent<{ threadId?: string }>).detail?.threadId;
      if (!threadId) return;
      // Close history entirely (also when it only shows a load error), so
      // the comments panel is not hidden behind it.
      setVersions(null);
      setVersionPreview(null);
      setHistoryError('');
      setPanel('comments');
      setThreadRequest({ threadId, nonce: Date.now() });
    };
    openLinkedThread();
    window.addEventListener('popstate', openLinkedThread);
    window.addEventListener('whiteboard-open-thread', openThread);
    return () => {
      window.removeEventListener('popstate', openLinkedThread);
      window.removeEventListener('whiteboard-open-thread', openThread);
    };
  }, [boardId]);

  // Following is owned by the canvas; mirror it for the header and Escape.
  useEffect(() => {
    // The canvas announces every start and stop of follow mode, including
    // presenter follow and stopping by moving the canvas.
    const reported = (event: Event) => setFollowingUserId((event as CustomEvent<{ userId?: string | null }>).detail?.userId ?? null);
    window.addEventListener('whiteboard-following', reported);
    return () => window.removeEventListener('whiteboard-following', reported);
  }, []);

  // Rejoining a presentation follows the presenter; when that presentation
  // ends, stop following, as the canvas does for presentations it joined.
  const joinedPresentation = useRef<string | null>(null);
  const runningPresentationId = collaboration?.presentation?.status === 'running' ? collaboration.presentation.id : null;
  useEffect(() => {
    const join = () => {
      const presentation = collaboration?.presentation;
      if (presentation?.status !== 'running') return;
      joinedPresentation.current = presentation.id;
      window.dispatchEvent(new CustomEvent('whiteboard-follow', { detail: { userId: presentation.presenterId, presentationId: presentation.id } }));
    };
    window.addEventListener('whiteboard-join-presentation', join);
    return () => window.removeEventListener('whiteboard-join-presentation', join);
  }, [collaboration?.presentation]);
  useEffect(() => {
    if (!joinedPresentation.current || joinedPresentation.current === runningPresentationId) return;
    joinedPresentation.current = null;
    if (followingUserId) window.dispatchEvent(new Event('whiteboard-stop-following'));
  }, [runningPresentationId, followingUserId]);

  useEffect(() => {
    if (versions || historyError) historyHeadingRef.current?.focus({ preventScroll: true });
  }, [Boolean(versions || historyError)]);

  const toggleHistory = async () => {
    if (versions) { closeHistory(); return; }
    setPanel(null);
    setHistoryError('');
    try {
      const response = await apiFetch(
        `/api/v1/boards/${encodeURIComponent(boardId)}/versions`
      );
      if (!response.ok) throw new Error(`History failed with ${response.status}`);
      const result = (await response.json()) as {
        versions: { revision: number; updatedAt: string; name?: string | null }[];
      };
      setVersions(result.versions);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    }
  };

  const previewVersion = async (revision: number) => {
    setHistoryError('');
    try {
      const response = await apiFetch(`/api/v1/boards/${encodeURIComponent(boardId)}/versions/${revision}/preview`);
      const result = await response.json() as typeof versionPreview & { error?: string };
      if (!response.ok || !result) throw new Error(result?.error ?? 'Preview failed');
      setVersionPreview(result);
    } catch (error) { setHistoryError(error instanceof Error ? error.message : 'Preview failed'); }
  };

  const restoreVersionInPlace = async (revision: number) => {
    setHistoryError('');
    try {
      const response = await apiFetch(`/api/v1/boards/${encodeURIComponent(boardId)}/versions/${revision}/restore`, { method: 'POST' });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Restore failed');
      location.reload();
    } catch (error) { setHistoryError(error instanceof Error ? error.message : 'Restore failed'); }
  };

  const restoreVersion = async (revision: number) => {
    setHistoryError('');
    try {
      const response = await apiFetch(
        `/api/v1/boards/${encodeURIComponent(boardId)}/versions/${revision}/restore-copy`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      const result = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !result.id) {
        throw new Error(result.error ?? `Restore failed with ${response.status}`);
      }
      navigateTo(`/boards/${encodeURIComponent(result.id)}`);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    }
  };

  const people = collaboration ? presenceOrder(uniqueParticipants(collaboration.participants), collaboration.currentUserId) : [];
  const role = collaboration ? facilitation(collaboration) : null;
  const live = collaboration ? workshopIsLive(collaboration) : false;
  const replyCount = collaboration?.comments.reduce((total, thread) => total + thread.replies.length, 0) ?? 0;
  const mentions = useBoardMentions(boardId, !guest && Boolean(collaboration), `${collaboration?.comments.length ?? 0}:${replyCount}`);
  // A brainstorm's time limit shows in the floating timer when no workshop
  // timer is running, so everyone can see it without opening the panel.
  const workshopTimer = collaboration?.timer && collaboration.timer.status !== 'ended' ? collaboration.timer : null;
  const brainstorm = collaboration?.brainstorm;
  const floatingTimer = workshopTimer ?? (brainstorm?.status === 'running' && brainstorm.endsAt
    ? { status: 'running' as const, label: brainstorm.title || 'Brainstorm', startedBy: brainstorm.startedBy, startedAt: brainstorm.startedAt, endsAt: brainstorm.endsAt, remainingMs: 0 }
    : collaboration?.timer ?? null);
  const [boardError, setBoardError] = useState('');
  // A short board-level notice, optionally with actions. Never takes focus.
  const [notice, setNotice] = useState<{ text: string; actions?: { label: string; primary?: boolean; run: () => void }[] } | null>(null);
  useEffect(() => {
    if (!notice || notice.actions) return;
    const timer = window.setTimeout(() => setNotice(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  // Followers are told when a presentation ended because its presenter left.
  const previousPresentation = useRef(collaboration?.presentation ?? null);
  useEffect(() => {
    const before = previousPresentation.current;
    const after = collaboration?.presentation ?? null;
    previousPresentation.current = after;
    if (before?.status !== 'running' || !after || after.id !== before.id || after.status !== 'ended' || after.endedReason !== 'presenter-left') return;
    if (after.presenterId === collaboration?.currentUserId) return;
    const name = collaboration?.participants.find(person => person.id === after.presenterId)?.name ?? 'The presenter';
    setNotice({ text: `${name} left, so the presentation ended.` });
  }, [collaboration?.presentation]);
  // During a private brainstorm, a sticky someone writes on the board is
  // public. When the canvas reports one (whiteboard-note-committed), offer to
  // move it into their private ideas instead.
  const brainstormRunning = collaboration?.brainstorm?.status === 'running' && Boolean(collaboration?.capabilities.comment);
  useEffect(() => {
    if (!brainstormRunning) return;
    const committed = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; text?: string; read?: () => string | null }>).detail;
      const text = detail?.text?.trim();
      if (!detail?.id || !text) return;
      const id = detail.id;
      let moving = false;
      setNotice({
        text: 'This note is visible to everyone. Make it a private idea instead?',
        actions: [
          { label: 'Make it private', primary: true, run: () => {
            if (moving) return;
            setBoardError('');
            moving = true;
            const move = async () => {
              // The last keystroke may still be in the canvas's save queue.
              const deadline = Date.now() + 5_000;
              while (syncStatus.current.connection === 'online' && syncStatus.current.saveState === 'saving' && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 50));
              }
              if (syncStatus.current.connection !== 'online' || syncStatus.current.saveState !== 'saved') throw new Error('Wait for this board to finish saving, then try again. Your note is still on the board.');
              const expectedText = detail.read?.();
              if (expectedText == null) throw new Error('This note is no longer available as a sticky note.');
              return sendCollaborationCommand(boardId, 'move_note_to_draft', { noteId: id, expectedText });
            };
            void move()
              .then(() => { setNotice({ text: 'Moved to your private ideas. Submit it when you are ready.' }); openWorkshop('brainstorm'); })
              .catch(error => setBoardError(error instanceof Error ? error.message : 'Could not make the note private.'))
              .finally(() => { moving = false; });
          } },
          { label: 'Keep on board', run: () => setNotice(null) },
        ],
      });
    };
    window.addEventListener('whiteboard-note-committed', committed);
    return () => window.removeEventListener('whiteboard-note-committed', committed);
  }, [brainstormRunning, boardId]);
  const raisedHands = collaboration ? Object.entries(collaboration.raisedHands).sort((a, b) => a[1].localeCompare(b[1])).map(([userId]) => people.find(person => person.id === userId)?.name ?? (userId === collaboration.currentUserId ? 'You' : 'Participant')) : [];
  const openComments = collaboration?.comments.filter(thread => !thread.resolvedAt).length ?? 0;

  return (
    <main className="app-shell" data-board-id={boardId} data-board-role={collaboration?.capabilities.role}>
      <header className="app-header">
        <div className="board-heading">
          <a className="home-link" href={guest ? "/" : studioReturnHref(collaboration?.currentUserId)} aria-label={guest ? "Open Whiteboard home" : "Back to studio"}><BoardIcon name="back" /></a>
          <div>
            <p className="eyebrow">{guest ? 'Guest access' : <>Studio <span aria-hidden="true">/</span> {workbookTitle}</>}</p>
            <h1>{title}</h1>
          </div>
        </div>
        <div className="header-actions">
          <span className={`save-status connection-${connection}`} title={`${saveState === 'saved' ? 'All changes saved' : saveState === 'saving' ? 'Saving changes' : 'Could not save changes'} · ${collaboration?.capabilities.role ?? 'viewer'} access`}>{connection === 'online' ? saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed' : 'Saved' : connection === 'offline' ? 'Offline' : 'Connecting'}</span>
          <button className={`presence-button ${panel === 'people' ? 'active' : ''}`} type="button" aria-label={`${people.length} ${people.length === 1 ? 'person' : 'people'} online${raisedHands.length ? `, ${raisedHands.length} with a raised hand` : ''}`} aria-pressed={panel === 'people'} title={people.map(person => `${person.name}${collaboration?.raisedHands[person.id] ? ' ✋' : ''}`).join(', ')} onClick={() => togglePanel('people')}>
          <span className="presence-stack" aria-hidden="true">
            {people.slice(0, 4).map(person => <span key={person.id} className={collaboration?.raisedHands[person.id] ? 'hand-raised' : undefined} title={`${person.name} · ${person.guest ? "guest · " : ""}${person.role}`} style={{ background: person.color, color: avatarInk(person.color) }}>{person.name.slice(0, 1).toUpperCase()}</span>)}
            {people.length > 4 ? <b>+{people.length - 4}</b> : null}
          </span>
          <span className="presence-count" aria-hidden="true"><UiIcon name="people" />{people.length}</span>
          </button>
          {raisedHands.length ? <button className="hands-button" type="button" aria-label={`${raisedHands.length} raised ${raisedHands.length === 1 ? 'hand' : 'hands'}: ${raisedHands.join(', ')}. Open raised hands`} title={`Raised hands: ${raisedHands.join(', ')}`} onClick={() => openWorkshop('signals')}><span aria-hidden="true">✋</span><b>{raisedHands.length}</b></button> : null}
          <span className="header-divider" aria-hidden="true" />
          <button className={`header-tool ${panel === 'comments' ? 'active' : ''}`} type="button" aria-label={`Comments${openComments ? `, ${openComments} open` : ''}${mentions.threads.length ? `, ${mentions.threads.length} mentioning you` : ''}`} aria-pressed={panel === 'comments'} title={mentions.threads.length ? 'Comments · you were mentioned' : 'Comments'} onClick={() => togglePanel('comments')}><BoardIcon name="comment" />{mentions.threads.length ? <b className="tool-badge mention-badge" aria-hidden="true">@</b> : openComments ? <b className="tool-badge" aria-hidden="true">{openComments}</b> : null}</button>
          <button className={`header-tool labelled-tool ${panel === 'workshop' ? 'active' : ''}`} type="button" aria-label={live ? 'Workshop tools, activity in progress' : 'Workshop tools'} aria-pressed={panel === 'workshop'} title="Workshop: timer, brainstorming and voting" onClick={() => togglePanel('workshop')}><BoardIcon name="facilitate" /><span>Workshop</span>{live ? <i className="live-dot" aria-hidden="true" /> : null}</button>
          <button className={`header-tool present-tool ${panel === 'present' ? 'active' : ''}`} type="button" aria-label="Present" aria-pressed={panel === 'present'} title="Present" onClick={() => togglePanel('present')}><BoardIcon name="present" /><span>Present</span></button>
          {!guest && <button className="share-button" type="button" onClick={() => setSharing(true)}><BoardIcon name="share" /><span>Share</span></button>}
          <ThemeMenu />
          {!guest && <DetailsMenu className="board-more">
            <summary aria-label="More board options" title="More"><BoardIcon name="more" /></summary>
            <div className="board-more-menu">
              <a href="/settings/account"><BoardIcon name="settings"/><span><strong>Account and security</strong><small>Sign-in methods, devices and administration</small></span></a>
              <a href={`/settings/connections?returnTo=${encodeURIComponent(location.pathname)}`}><BoardIcon name="apps" /><span><strong>Connected apps</strong><small>Set up ChatGPT, Claude and MCP clients</small></span></a>
              <button type="button" onClick={() => togglePanel('activity')}><BoardIcon name="activity" /><span><strong>Activity</strong><small>Checkpoints and recent changes</small></span></button>
              <button type="button" onClick={event => { historyTrigger.current = event.currentTarget; void toggleHistory(); }}><BoardIcon name="history" /><span><strong>{versions ? 'Close history' : 'History'}</strong><small>Preview and restore earlier versions</small></span></button>
              {collaboration?.capabilities.export ? <a href={`/api/v1/boards/${encodeURIComponent(boardId)}/export`} download><BoardIcon name="download" /><span><strong>Download archive</strong><small>Save an editable backup</small></span></a> : null}
            </div>
          </DetailsMenu>}
        </div>
      </header>
      {(versions || historyError) && (
        <aside className="history-panel" aria-labelledby="board-history-heading">
          <header className="history-heading"><div><h2 id="board-history-heading" ref={historyHeadingRef} tabIndex={-1}>History</h2><span>Preview a version before you restore it.</span></div><button className="panel-close" type="button" aria-label="Close version history" onClick={closeHistory}><UiIcon name="close" /></button></header>
          {!versionPreview && <div className="history-illustration" aria-hidden="true"><HistoryArt /></div>}
          {historyError && <p role="alert">{historyError}</p>}
          {versions?.length === 0 && <p>No saved revisions yet.</p>}
          {versionPreview ? <section className="version-preview"><strong>Revision {versionPreview.revision}</strong><p>{versionPreview.noteCount} notes · {versionPreview.frameCount} frames · {versionPreview.connectorCount} connectors</p>{versionPreview.notes.slice(0, 4).map((note, index) => <blockquote key={`${index}:${note}`}>{note}</blockquote>)}<div className="button-row">{canCopy ? <button type="button" onClick={() => void restoreVersion(versionPreview.revision)}>Restore as copy</button> : null}{collaboration?.capabilities.manage ? <button className="danger-button" type="button" onClick={() => void restoreVersionInPlace(versionPreview.revision)}>Restore this board</button> : null}<button type="button" onClick={() => setVersionPreview(null)}>Close preview</button></div></section> : null}
          <ol>
            {versions?.map(version => (
              <li key={version.revision}>
                <div><strong>{version.name || `Revision ${version.revision}`}</strong><small>{version.name ? `Revision ${version.revision} · ` : ''}{new Date(version.updatedAt).toLocaleString()}</small></div>
                <button type="button" onClick={() => void previewVersion(version.revision)}>Preview</button>
              </li>
            ))}
          </ol>
        </aside>
      )}
      <div className={`board-workspace ${panel ? 'panel-open' : ''}`}>
        <Suspense fallback={<div className="canvas-loading" role="status"><span className="canvas-spinner" aria-hidden="true" />Opening your board…</div>}>
          {loading?.boardId === boardId ? <EditorCanvas boardId={boardId} bootstrap={loading.promise} onCollaboration={updateCollaboration} onConnection={updateConnection} onSaveState={updateSaveState} onComment={() => togglePanel('comments')} /> : <div className="canvas-loading" role="status"><span className="canvas-spinner" aria-hidden="true" />Opening your board…</div>}
        </Suspense>
        {panel && collaboration ? <CollaborationPanel boardId={boardId} state={collaboration} tab={panel} viewRequest={viewRequest} onViewRequestHandled={consumeViewRequest} threadRequest={threadRequest} onThreadRequestHandled={consumeThreadRequest} followingUserId={followingUserId} mentionThreads={mentions.threads} onMentionSeen={mentions.seen} onClose={() => setPanel(null)} /> : null}
      </div>
      {collaboration ? <ActivityPill state={collaboration} followingUserId={followingUserId} hidden={panel === 'workshop' ? ['brainstorm', 'vote'] : panel === 'present' ? ['presentation'] : []} onOpen={activity => {
        if (activity.kind === 'presentation' && collaboration.presentation) {
          joinedPresentation.current = collaboration.presentation.id;
          window.dispatchEvent(new CustomEvent('whiteboard-follow', { detail: { userId: collaboration.presentation.presenterId, presentationId: collaboration.presentation.id } }));
        }
        else openWorkshop(activity.kind === 'vote' ? 'voting' : 'brainstorm');
      }} /> : null}
      {collaboration ? <PresenterBar boardId={boardId} state={collaboration} onError={setBoardError} /> : null}
      {notice ? <div className="board-notice" role="status"><span>{notice.text}</span>{notice.actions?.map(action => <button type="button" key={action.label} className={action.primary ? 'primary' : undefined} onClick={action.run}>{action.label}</button>)}{!notice.actions ? <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>OK</button> : null}</div> : null}
      {boardError ? <p className="board-chrome-error" role="alert">{boardError}<button type="button" aria-label="Dismiss" onClick={() => setBoardError('')}><UiIcon name="close" /></button></p> : null}
      <BoardTimer boardId={boardId} timer={floatingTimer} kind={workshopTimer || !brainstorm?.endsAt ? 'timer' : 'brainstorm'} canControl={Boolean(role?.leads)} online={connection === 'online'} onOpen={() => openWorkshop(workshopTimer || !brainstorm?.endsAt ? 'timer' : 'brainstorm')} />
      {sharing ? <ShareDialog boardId={boardId} onClose={() => setSharing(false)} /> : null}
    </main>
  );
}

function InvitationGate() {
  const [message, setMessage] = useState('Accepting your invitation…');
  useEffect(() => {
    const match = location.hash.match(/^#(invite|invitation)=([^&]+)$/u);
    if (!match) return;
    const kind = match[1];
    const value = decodeURIComponent(match[2]);
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    void apiFetch(kind === 'invite' ? '/api/v1/invitations/accept' : `/api/v1/invitations/${encodeURIComponent(value)}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: kind === 'invite' ? JSON.stringify({ token: value }) : undefined })
      .then(async response => {
        const result = await response.json() as { boardId?: string; workbookId?: string; error?: string };
        if (!response.ok || (!result.boardId && !result.workbookId)) throw new Error(result.error ?? 'Invitation could not be accepted');
        location.replace(result.boardId ? `/boards/${encodeURIComponent(result.boardId)}` : '/');
      })
      .catch(error => setMessage(error instanceof Error ? error.message : 'Invitation could not be accepted'));
  }, []);
  return <main className="invitation-page"><div className="invitation-card"><BrandMark /><h1>Open Whiteboard invitation</h1><p>{message}</p><a href="/">Go to your boards</a></div></main>;
}

export function App() {
  const url = useAppLocation();
  if (url.pathname === '/settings/connections') return <Suspense fallback={<main className="canvas-loading" role="status">Opening connected apps…</main>}><ConnectedApps /></Suspense>;
  if (url.pathname.startsWith('/settings/')) return <Suspense fallback={<main className="canvas-loading" role="status">Opening settings…</main>}><Settings section={url.pathname.slice('/settings/'.length)} /></Suspense>;
  if (url.hash.startsWith('#invite=') || url.hash.startsWith('#invitation=')) return <InvitationGate />;
  const boardMatch = url.pathname.match(/^\/boards\/([^/]+)$/u);
  if (!boardMatch) return <Home />;
  const boardId = decodeURIComponent(boardMatch[1]);
  return <BoardPage key={boardId} boardId={boardId} />;
}
