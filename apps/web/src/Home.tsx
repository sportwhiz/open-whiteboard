import { studioSessionKey } from "./studio-session";
import { DetailsMenu } from "./DetailsMenu";
import { focusOrFallback, usePopover } from "./usePopover";
import { BrandMark } from "./BrandMark";
import { MarkerTagline } from "./MarkerTagline";
import { ThemedImage } from "./ThemedImage";
import { MarkerColorField } from "./MarkerColorField";
import { PRODUCT_NAME, PRODUCT_WORDMARK } from "./product";
import { openTour } from './onboarding-events';
import { api, apiFetch, authSnapshot, studioTitle } from "./auth-client";
import { useDialogFocus } from "./useDialogFocus";
import { UiIcon } from "./UiIcon";
import {
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ShareDialog } from './ShareDialog';
import { ThemeMenu } from './theme';
import { avatarInk } from './avatar-color';
import { navigateTo } from './app-navigation';
import { titleMatches } from './search-rank';
import {
  type BoardLayout,
  type BrowseSort,
  type SearchSort,
  type StudioRoute,
  type StudioView,
  MAX_QUERY_LENGTH,
  browseRoute,
  parseStudioRoute,
  agree,
  firstWorkbookGate,
  plural,
  readStudioPrefs,
  relativeTime,
  sectionBoards,
  sharedWithMe,
  studioHref,
  viewKey,
  workbookTree,
  writeStudioPrefs,
} from './studio-view';
import type { Board, Catalog, Folder, Trash, TrashedBoard, Workbook } from './studio-types';
import { BoardCollection, roleLabel, WorkbookGlyph, type BoardItemProps } from './StudioBoards';
import { MovePicker, SelectedInput } from './MovePicker';
import { StudioTrash } from './StudioTrash';

type SearchMatch = { id: string; excerpt?: string };

type Modal =
  | { kind: 'create' }
  | { kind: 'rename'; board: Board }
  | { kind: 'move'; board: Board }
  | { kind: 'restore'; board: TrashedBoard }
  | { kind: 'workbook'; workbook: Workbook }
  | { kind: 'delete-workbook'; workbook: Workbook; boards: number }
  | { kind: 'new-workbook' }
  | { kind: 'new-folder' }
  | { kind: 'rename-folder'; folder: Folder }
  | null;

/** One dialog is open at a time; each opens with a fresh draft so forms never leak into each other. */
type Draft = { title: string; folderId: string; workbookId: string; private: boolean; filter: string };
const EMPTY_DRAFT: Draft = { title: '', folderId: '', workbookId: '', private: false, filter: '' };

type Notification = { id: string; title: string; body: string; href?: string; createdAt: string; readAt?: string };
type Profile = { id: string; name: string; email: string; color: string; authentication: string };
type Notice = { text: string; id: number; pending?: boolean; action?: { label: string; run: () => void } };
type ActionResult = void | { notice?: string; undo?: () => void };

const EMPTY_CATALOG: Catalog = { folders: [], workbooks: [], boards: [] };
const FIRST_WORKBOOK_TITLE = 'My boards';
/** Folder select value meaning "leave it in the other owner's folder". */
const FILED_ELSEWHERE = 'filed-elsewhere';
const WORKBOOK_FILTER_THRESHOLD = 8;
/** Title matches (from the catalog already loaded) follow typing almost at once. */
const SEARCH_DELAY = 150;
/** Note text is searched on the server only after a longer pause, or on Enter. */
const NOTES_DELAY = 450;
const NOTES_MIN_LENGTH = 3;
/** Slow actions show progress only if they take longer than this, to avoid flicker. */
const PENDING_DELAY = 250;

async function request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const response = await apiFetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    let code = '';
    try { const body = JSON.parse(text); message = typeof body.error === 'string' ? body.error : `Request failed (${response.status})`; code = typeof body.code === 'string' ? body.code : ''; } catch { /* Plain-text errors remain readable. */ }
    throw Object.assign(new Error(message || `Request failed (${response.status})`), { code });
  }

  const contentType = response.headers.get('content-type');
  return contentType?.includes('application/json') ? response.json() : response.blob();
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable="true"]')));
const plainClick = (event: ReactMouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
const visible = (element: Element | null | undefined): element is HTMLElement => element instanceof HTMLElement && element.getClientRects().length > 0;
const storage = () => (typeof localStorage === 'undefined' ? undefined : localStorage);

/** The workbook a search is limited to, if any. */
const scopedWorkbook = (route: StudioRoute) => route.query && route.view.kind === 'workbook' && route.scope === 'view' ? route.view.id : '';
const searchKeyFor = (route: StudioRoute) => route.query ? `${scopedWorkbook(route)}\u0000${route.query}` : '';

function boardControl(id: string, part: 'menu' | 'link') {
  const card = Array.from(document.querySelectorAll<HTMLElement>('[data-board-id]')).find(item => item.dataset.boardId === id);
  return card?.querySelector<HTMLElement>(part === 'menu' ? '.board-menu > summary' : '.board-card-link') ?? null;
}

/** A button that takes focus when its dialog opens: the safe choice in a confirmation. */
function AutoFocusButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  return <button ref={ref} {...props} />;
}

export function Home() {
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [noticeHeld, setNoticeHeld] = useState(false);
  const [route, setRoute] = useState<StudioRoute>(() => parseStudioRoute(location.search));
  const [queryInput, setQueryInput] = useState(route.query);
  const [prefs, setPrefs] = useState(() => readStudioPrefs(storage()));
  const [searchSort, setSearchSort] = useState<SearchSort>('relevance');
  const [notes, setNotes] = useState<{ key: string; query: string; workbookId: string; items: SearchMatch[]; status: 'complete' | 'partial' | 'limited' | 'failed' } | null>(null);
  const [notesPending, setNotesPending] = useState(false);
  const [notesNow, setNotesNow] = useState<{ key: string } | null>(null);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [workbookFilter, setWorkbookFilter] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [highlighted, setHighlighted] = useState('');
  // Cards keep their place while starring, until the next view change.
  const [placedFavorites, setPlacedFavorites] = useState<Record<string, boolean>>({});
  const [activeCard, setActiveCard] = useState('');
  const [activeTreeRow, setActiveTreeRow] = useState('');
  const [trash, setTrash] = useState<Trash | null>(null);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashFailed, setTrashFailed] = useState(false);
  const [restoringId, setRestoringId] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<(() => HTMLElement | null) | null>(null);
  const closeModal = () => { setModal(null); setDialogError(''); };
  useDialogFocus(dialogRef, Boolean(modal), closeModal, dialogTrigger);
  const importRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileName, setProfileName] = useState('');
  const [profileColor, setProfileColor] = useState('#4262ff');
  const [showAccount, setShowAccount] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const accountRef = useRef<HTMLElement>(null);
  const accountTrigger = useRef<HTMLButtonElement>(null);
  const notificationsRef = useRef<HTMLElement>(null);
  const notificationsHeading = useRef<HTMLHeadingElement>(null);
  const notificationsTrigger = useRef<HTMLButtonElement>(null);
  usePopover(accountRef, showAccount, () => setShowAccount(false), accountTrigger);
  // Land on the heading, not "Mark all as read": one stray Enter must not clear every notification.
  usePopover(notificationsRef, showNotifications, () => setShowNotifications(false), notificationsTrigger, undefined, { autoFocus: false });
  useEffect(() => { if (showNotifications) notificationsHeading.current?.focus({ preventScroll: true }); }, [showNotifications]);

  const [sharingWorkbook, setSharingWorkbook] = useState<Workbook | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const editableWorkbooks = catalog.workbooks.filter(workbook => workbook.id !== 'workbook:shared' && (workbook.role === 'owner' || workbook.role === 'editor'));
  const canAddBoards = editableWorkbooks.length > 0 || canCreate;

  const loadCatalog = async () => {
    const next = (await request('/api/v1/catalog')) as Catalog;
    setCatalog(next);
    return next;
  };

  const loadWorkspace = () => {
    setLoading(true);
    setLoadFailed(false);
    setError('');
    return request('/api/v1/workspace').then(value => {
      const account = value as { catalog: Catalog; user: Profile; workspace: { owner: boolean; canCreate: boolean }; notifications: { notifications: Notification[] } };
      setCatalog(account.catalog);
      setProfile(account.user);
      setCanCreate(account.workspace.canCreate);
      setProfileName(account.user.name);
      setProfileColor(account.user.color);
      setNotifications(account.notifications.notifications);
    }).catch(() => setLoadFailed(true))
      .finally(() => setLoading(false));
  };

  useEffect(() => { void loadWorkspace(); }, []);

  // Views live in the address bar so Back, Forward, reload and shared links all work.
  useEffect(() => {
    const sync = () => {
      if (location.pathname !== '/') return;
      const next = parseStudioRoute(location.search);
      setRoute(next);
      setQueryInput(next.query);
      setNavigationOpen(false);
      // Back and Forward can remove the control that had focus; continue from the page heading.
      window.requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body || !visible(active)) headingRef.current?.focus({ preventScroll: true });
      });
    };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  // Timers and handlers read the latest route, not the one from when they were scheduled.
  const routeRef = useRef(route);
  routeRef.current = route;

  const go = (next: StudioRoute, mode: 'push' | 'replace' = 'push') => {
    const previous = routeRef.current;
    const href = studioHref(next);
    const current = `${location.pathname}${location.search}`;
    // Remember where a search started so clearing it can step back instead of stacking entries.
    const from = previous.query ? history.state?.studioSearchFrom : studioHref(browseRoute(previous.view));
    const state = next.query ? { studioSearchFrom: from } : null;
    if (href !== current) history[mode === 'push' ? 'pushState' : 'replaceState'](state, '', href);
    routeRef.current = next;
    setRoute(next);
  };

  // Boards link back to the exact Studio view they were opened from.
  const routeHref = studioHref(route);
  useEffect(() => {
    try { sessionStorage.setItem(studioSessionKey('return', profile?.id), `${location.pathname}${location.search}`); } catch { /* Storage may be unavailable. */ }
    // A new view (or sort) is the moment starred cards settle into place.
    setPlacedFavorites({});
  }, [routeHref, prefs.sort, profile?.id]);

  const openView = (view: StudioView) => {
    const wasDrawer = navigationOpen;
    setNavigationOpen(false);
    setError('');
    setQueryInput('');
    if (studioHref(browseRoute(view)) !== studioHref(routeRef.current)) {
      go(browseRoute(view));
      window.scrollTo({ top: 0 });
    }
    // The drawer hides the link that was used; continue from the page heading.
    if (wasDrawer) pendingFocus.current = () => headingRef.current;
  };

  const viewLink = (view: StudioView) => ({
    href: studioHref(browseRoute(view)),
    onClick: (event: ReactMouseEvent) => {
      if (!plainClick(event)) return;
      event.preventDefault();
      openView(view);
    },
  });

  const leaveSearch = () => {
    setNotesPending(false);
    const current = routeRef.current;
    if (!current.query) return;
    const base = browseRoute(current.view);
    if (history.state?.studioSearchFrom === studioHref(base)) history.back();
    else go(base, 'replace');
    routeRef.current = base;
    setRoute(base);
  };

  const commitQuery = (value: string) => {
    const current = routeRef.current;
    const trimmed = value.trim().slice(0, MAX_QUERY_LENGTH);
    if (trimmed === current.query) return current;
    if (!trimmed) { leaveSearch(); return routeRef.current; }
    setError('');
    // Trash is not searchable; a search from there looks across all boards.
    const next: StudioRoute = { ...current, view: current.view.kind === 'trash' ? { kind: 'all' } : current.view, query: trimmed };
    go(next, current.query ? 'replace' : 'push');
    return next;
  };

  const setScope = (scope: StudioRoute['scope']) => {
    const next = { ...routeRef.current, scope };
    go(next, 'replace');
    searchNotesNow(next);
  };

  /** Search note text now (Enter, or an explicit scope change) instead of after the pause. */
  const searchNotesNow = (next: StudioRoute) => { if (next.query) setNotesNow({ key: searchKeyFor(next) }); };

  // Live search: commit the typed text after a short pause.
  useEffect(() => {
    const trimmed = queryInput.trim();
    if (trimmed === routeRef.current.query) return;
    const timer = window.setTimeout(() => commitQuery(queryInput), trimmed ? SEARCH_DELAY : 0);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  const scopedWorkbookId = scopedWorkbook(route);
  const searchKey = searchKeyFor(route);
  // Note text: one server search after a pause (or on Enter), cancelled as soon as
  // the query changes. Title matches never wait for it.
  useEffect(() => {
    if (!searchKey) { setNotesPending(false); return; }
    const eager = notesNow?.key === searchKey;
    if (!eager && route.query.length < NOTES_MIN_LENGTH) { setNotesPending(false); return; }
    if (!eager && notes?.key === searchKey && notes.status !== 'failed') { setNotesPending(false); return; }
    const controller = new AbortController();
    const query = route.query;
    const workbookId = scopedWorkbookId;
    setNotesPending(true);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: query });
      if (workbookId) params.set('workbookId', workbookId);
      apiFetch(`/api/v1/search?${params}`, { signal: controller.signal }).then(async response => {
        if (response.status === 429) { setNotes({ key: searchKey, query, workbookId, items: [], status: 'limited' }); return; }
        if (!response.ok) throw new Error(`Search failed (${response.status})`);
        const result = await response.json() as { matches: Array<{ board: Board; excerpt?: string }>; complete?: boolean };
        if (controller.signal.aborted) return;
        setNotes({ key: searchKey, query, workbookId, items: result.matches.map(match => ({ id: match.board.id, excerpt: match.excerpt })), status: result.complete === false ? 'partial' : 'complete' });
      }).catch(() => {
        if (!controller.signal.aborted) setNotes({ key: searchKey, query, workbookId, items: [], status: 'failed' });
      }).finally(() => {
        if (!controller.signal.aborted) setNotesPending(false);
      });
    }, eager ? 0 : NOTES_DELAY);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [searchKey, notesNow]);

  useEffect(() => writeStudioPrefs(storage(), prefs), [prefs]);

  // Notices leave on their own, later when they offer Undo, and never while
  // someone is pointing at or tabbed into them. Progress waits for its result.
  useEffect(() => {
    if (!notice || notice.pending || noticeHeld) return;
    const timer = window.setTimeout(() => setNotice(null), notice.action ? 8000 : 3600);
    return () => window.clearTimeout(timer);
  }, [notice, noticeHeld]);

  useEffect(() => {
    if (!highlighted) return;
    const timer = window.setTimeout(() => setHighlighted(''), 2600);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  // `/` and Cmd/Ctrl+K find boards; Cmd/Ctrl+Z undoes the last trash while its notice shows.
  const noticeRef = useRef(notice);
  noticeRef.current = notice;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      if (document.querySelector('[aria-modal="true"], .onboarding-card')) return;
      const undo = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z';
      if (undo && noticeRef.current?.action) {
        event.preventDefault();
        const action = noticeRef.current.action;
        setNotice(null);
        action.run();
        return;
      }
      const shortcut = (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) ||
        ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k');
      if (!shortcut) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  // The mobile drawer closes when someone taps outside it or presses Escape anywhere.
  useEffect(() => {
    if (!navigationOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || sidebarRef.current?.contains(target) || target.closest('.studio-scrim, .onboarding-backdrop, .onboarding-card, [role=dialog]')) return;
      setNavigationOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || modal || document.querySelector('.onboarding-card')) return;
      event.preventDefault();
      setNavigationOpen(false);
      menuToggleRef.current?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape);
    };
  }, [navigationOpen, modal]);

  const toggleNavigation = () => {
    const opening = !navigationOpen;
    setNavigationOpen(opening);
    // Opening the drawer moves focus into it (not while a guided tour drives it).
    if (opening && !document.querySelector('.onboarding-card')) {
      pendingFocus.current = () => {
        const target = sidebarRef.current?.querySelector<HTMLElement>('#studio-navigation .nav-item[aria-current="page"], #studio-navigation .nav-item');
        return visible(target) ? target : null;
      };
    }
  };

  // Apply a focus request once the element it names has rendered.
  useLayoutEffect(() => {
    const find = pendingFocus.current;
    if (!find || modal) return;
    const target = find();
    if (!target) return;
    pendingFocus.current = null;
    focusOrFallback(target, headingRef.current);
    target.scrollIntoView?.({ block: 'nearest' });
  });

  const activeKey = viewKey(route.view);
  // Keep the open workbook visible in a long sidebar.
  useEffect(() => {
    if (loading) return;
    const item = sidebarRef.current?.querySelector<HTMLElement>('.workbook-list [aria-current="page"], .workbook-list .folder-row.has-current');
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeKey, loading, catalog.workbooks.length]);

  // Returning from a board lands on the card it was opened from, where it was.
  useEffect(() => {
    if (loading || loadFailed) return;
    let saved: { id?: string; href?: string; scrollY?: number } | null = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(studioSessionKey('return-card', profile?.id)) ?? 'null');
      sessionStorage.removeItem(studioSessionKey('return-card', profile?.id));
    } catch { /* Storage may be unavailable. */ }
    if (!saved?.id || saved.href !== `${location.pathname}${location.search}`) return;
    const id = saved.id;
    const scrollY = Number(saved.scrollY) || 0;
    window.requestAnimationFrame(() => {
      const link = boardControl(id, 'link');
      if (!link) return;
      window.scrollTo({ top: scrollY });
      setActiveCard(id);
      link.focus({ preventScroll: true });
    });
  }, [loading, loadFailed]);

  const showNotice = (text: string, extra: Omit<Notice, 'text' | 'id'> = {}) => setNotice({ text, id: Date.now() + Math.random(), ...extra });

  /** Never leave keyboard users on <body> after an action removes or moves what they used. */
  const rescueFocus = (boardId?: string, index = -1) => window.requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body && visible(active)) return;
    if (pendingFocus.current) return;
    if (boardId) {
      const menu = boardControl(boardId, 'menu');
      if (menu) { menu.focus({ preventScroll: true }); return; }
    }
    const links = Array.from(document.querySelectorAll<HTMLElement>('.board-card-link'));
    if (index >= 0 && links.length) { links[Math.min(index, links.length - 1)].focus({ preventScroll: true }); return; }
    headingRef.current?.focus({ preventScroll: true });
  });

  const run = async (action: () => Promise<ActionResult>, options: { success?: string; inDialog?: boolean; boardId?: string; pending?: string } = {}) => {
    const report = options.inDialog ? setDialogError : setError;
    const index = options.boardId ? Array.from(document.querySelectorAll<HTMLElement>('[data-board-id]')).findIndex(item => item.dataset.boardId === options.boardId) : -1;
    // Only rescue focus that the action itself lost; a pointer click that never moved focus is left alone.
    const hadFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body;
    const pendingId = Date.now() + Math.random();
    const pendingTimer = options.pending ? window.setTimeout(() => setNotice({ text: options.pending!, id: pendingId, pending: true }), PENDING_DELAY) : 0;
    const clearPending = () => { window.clearTimeout(pendingTimer); setNotice(current => current?.id === pendingId ? null : current); };
    setBusy(true);
    report('');
    try {
      const result = await action();
      try { await loadCatalog(); }
      catch { report('Your change was saved, but the list could not refresh. Reload the page to see it.'); }
      clearPending();
      const text = (result && result.notice) || options.success;
      if (text) showNotice(text, result && result.undo ? { action: { label: 'Undo', run: result.undo } } : {});
      if (hadFocus || options.inDialog) rescueFocus(options.boardId, index);
      return true;
    } catch (actionError) {
      clearPending();
      report(message(actionError, 'Something went wrong.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openModal = (next: NonNullable<Modal>, values: Partial<Draft> = {}) => {
    setDraft({ ...EMPTY_DRAFT, ...values });
    setDialogError('');
    setModal(next);
  };

  const activeWorkbook = route.view.kind === 'workbook'
    ? catalog.workbooks.find(workbook => workbook.id === (route.view as { id: string }).id) ?? null
    : null;

  const openCreate = () => {
    if (!canAddBoards) return;
    setNavigationOpen(false);
    // Default to the open workbook, else wherever the person worked most recently.
    const editable = new Set(editableWorkbooks.map(item => item.id));
    const recent = [...catalog.boards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).find(board => board.workbookId && editable.has(board.workbookId));
    const workbookId = activeWorkbook && editable.has(activeWorkbook.id) ? activeWorkbook.id : recent?.workbookId ?? editableWorkbooks[0]?.id ?? '';
    openModal({ kind: 'create' }, { title: 'Untitled board', workbookId });
  };

  /** First run: give a new person somewhere to put their first board instead of asking them to file it. */
  // Created at most once: a retry after a failed board creation reuses it.
  const ensureWorkbook = useMemo(() => firstWorkbookGate(async () => {
    const created = await request('/api/v1/workbooks', 'POST', { title: FIRST_WORKBOOK_TITLE }) as { id: string };
    return created.id;
  }), []);

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setDialogError('');
    try {
      const workbookId = await ensureWorkbook(draft.workbookId);
      // If the board itself fails, the dialog now offers the workbook that was just made.
      setDraft(current => ({ ...current, workbookId }));
      const created = (await request('/api/v1/boards', 'POST', {
        title: draft.title.trim() || 'Untitled board',
        workbookId,
        private: draft.private,
      })) as { id: string };
      navigateTo(`/boards/${encodeURIComponent(created.id)}`);
    } catch (createError) {
      setDialogError(message(createError, 'Could not create the board.'));
      setBusy(false);
      void loadCatalog().catch(() => undefined);
    }
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (modal?.kind !== 'rename') return;
    const title = draft.title.trim();
    if (!title) return;
    const boardId = modal.board.id;
    if (title === modal.board.title) { closeModal(); return; }
    await run(async () => {
      await request(`/api/v1/boards/${encodeURIComponent(boardId)}/catalog`, 'PATCH', { title });
      setModal(null);
    }, { success: 'Board renamed', inDialog: true, boardId });
  };

  /**
   * When an action takes a card out of the current view, continue from the next
   * card in reading order (else the previous one, else the heading), but only
   * once the card has actually left, so a dialog restoring focus first cannot
   * strand keyboard users on <body>.
   */
  const focusWhenGone = (boardId: string) => {
    const order = Array.from(document.querySelectorAll<HTMLElement>('[data-board-id]')).map(card => card.dataset.boardId ?? '');
    const index = order.indexOf(boardId);
    const neighbours = index < 0 ? [] : [...order.slice(index + 1), ...order.slice(0, index).reverse()];
    pendingFocus.current = () => {
      if (boardControl(boardId, 'link')) return null;
      for (const id of neighbours) {
        const link = boardControl(id, 'link');
        if (link) { setActiveCard(id); return link; }
      }
      return headingRef.current;
    };
  };

  const moveBoard = async (board: Board, workbookId: string) => {
    const target = editableWorkbooks.find(item => item.id === workbookId);
    if (!target || workbookId === board.workbookId) return;
    // Leaving this workbook (or a search scoped to it) removes the card from view.
    if (route.view.kind === 'workbook' || scopedWorkbookId) focusWhenGone(board.id);
    const from = board.workbookId;
    const origin = editableWorkbooks.find(item => item.id === from);
    const moved = await run(async () => {
      await request(`/api/v1/boards/${encodeURIComponent(board.id)}/catalog`, 'PATCH', { workbookId });
      setModal(null);
      return {
        notice: `Moved to ${target.title}`,
        // Undo moves it straight back, when its old workbook still accepts it.
        undo: origin ? () => void run(async () => {
          await request(`/api/v1/boards/${encodeURIComponent(board.id)}/catalog`, 'PATCH', { workbookId: origin.id });
          setHighlighted(board.id);
          pendingFocus.current = () => boardControl(board.id, 'link');
        }, { success: `Moved back to ${origin.title}`, pending: 'Moving…' }) : undefined,
      };
    }, { inDialog: true, boardId: board.id, pending: 'Moving…' });
    if (!moved) pendingFocus.current = null;
  };

  /** After a restore in Trash, continue from the item that took its place (else the one before, else the heading). */
  const trashRowIndex = (id: string) => Array.from(document.querySelectorAll<HTMLElement>('.trash-row')).findIndex(row => row.dataset.trashId === id);
  const trashFocus = (index: number) => () => {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('.trash-row button'));
    return buttons[Math.min(Math.max(index, 0), buttons.length - 1)] ?? headingRef.current;
  };

  /** Put a trashed board back. Undo uses this too, so it lands on the restored card. */
  const restoreBoard = (board: { id: string; title: string; workbookId?: string | null; private?: boolean }, workbookId?: string) => {
    const index = trashRowIndex(board.id);
    return run(async () => {
      setRestoringId(board.id);
      try {
        await request(`/api/v1/boards/${encodeURIComponent(board.id)}/restore`, 'POST', workbookId ? { workbookId } : {});
      } catch (restoreError) {
        // Its workbook went to the trash too (for example, after an Undo): choose where it goes instead.
        if (errorCode(restoreError) !== 'WORKBOOK_TRASHED' || workbookId) throw restoreError;
        openModal({ kind: 'restore', board: { id: board.id, title: board.title, workbookId: board.workbookId ?? '', workbookTitle: null, workbookDeletedAt: 'trashed', deletedAt: '', updatedAt: '', private: Boolean(board.private) } });
        return;
      } finally { setRestoringId(''); }
      setModal(null);
      setHighlighted(board.id);
      if (routeRef.current.view.kind === 'trash') {
        await loadTrash();
        pendingFocus.current = trashFocus(index);
      } else pendingFocus.current = () => boardControl(board.id, 'link');
      return { notice: `Restored “${board.title}”` };
    }, { inDialog: Boolean(workbookId), pending: 'Restoring…' });
  };

  const trashBoard = (board: Board) => {
    focusWhenGone(board.id);
    void run(async () => {
      await request(`/api/v1/boards/${encodeURIComponent(board.id)}/catalog`, 'DELETE');
      return { notice: `Moved “${board.title}” to the trash`, undo: () => void restoreBoard(board) };
    }, { boardId: board.id, pending: 'Moving to trash…' });
  };

  const duplicateBoard = (board: Board) => void run(async () => {
    const copy = await request(`/api/v1/boards/${encodeURIComponent(board.id)}/duplicate`, 'POST', {}) as { id: string; title: string };
    setHighlighted(copy.id);
    setActiveCard(copy.id);
    pendingFocus.current = () => boardControl(copy.id, 'link');
    return { notice: `Duplicated as “${copy.title}”` };
  }, { boardId: board.id, pending: 'Duplicating…' });

  // Starring changes the star at once but leaves the card where it is, so the
  // page never jumps and focus stays put; it settles on the next view change.
  const toggleFavorite = (board: Board, fromMenu: boolean) => {
    setPlacedFavorites(current => board.id in current ? current : { ...current, [board.id]: board.favorite });
    void run(async () => {
      await request(`/api/v1/boards/${encodeURIComponent(board.id)}/catalog`, 'PATCH', { favorite: !board.favorite });
    }, { success: board.favorite ? 'Removed from favorites' : 'Added to favorites', boardId: fromMenu ? board.id : undefined });
  };

  const exportBoard = (board: Board) => void run(async () => {
    const blob = (await request(`/api/v1/boards/${encodeURIComponent(board.id)}/export`)) as Blob;
    downloadBlob(blob, `${board.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'board'}.whiteboard.json`);
  }, { success: 'Archive downloaded', boardId: board.id, pending: 'Preparing archive…' });

  const importArchive = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setError('');
    showNotice('Importing…', { pending: true });
    let imported = 0;
    try {
      const preferred = activeWorkbook && editableWorkbooks.some(workbook => workbook.id === activeWorkbook.id) ? activeWorkbook.id : editableWorkbooks[0]?.id ?? '';
      if (!preferred && !canCreate) throw new Error('An editable workbook is required to import a board.');
      const { prepareImportFiles } = await import('./recovery-import');
      const archives = await prepareImportFiles(file);
      const workbookId = await ensureWorkbook(preferred);
      for (const archive of archives) {
        const response = await apiFetch(`/api/v1/import?workbookId=${encodeURIComponent(workbookId)}`, {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/vnd.personal-whiteboard+json' },
          body: archive,
        });
        if (!response.ok) { const failure = await response.json().catch(() => ({})); throw new Error(failure.error || 'Import failed.'); }
        imported++;
      }
      await loadCatalog();
      showNotice(imported === 1 ? 'Board imported' : `${imported} boards recovered`);
    } catch (importError) {
      setNotice(null);
      await loadCatalog().catch(() => undefined);
      setError(`${imported ? `${imported} boards imported before the import stopped. Keep your recovery file. ` : ''}${message(importError, 'Import failed.')}`);
    } finally {
      setBusy(false);
    }
  };

  const settingsFolder = (workbook: Workbook) => workbook.filedElsewhere ? FILED_ELSEWHERE : workbook.folderId ?? '';
  const [coOwned, setCoOwned] = useState(false);
  const openWorkbookSettings = (workbook: Workbook) => {
    setCoOwned(false);
    openModal({ kind: 'workbook', workbook }, { title: workbook.title, folderId: settingsFolder(workbook) });
    // Only mention co-owners when there are some.
    void request(`/api/v1/workbooks/${encodeURIComponent(workbook.id)}/share`).then(value => {
      const state = value as { collaborators?: Array<{ role: string }> };
      setCoOwned((state.collaborators ?? []).filter(person => person.role === 'owner').length > 1);
    }).catch(() => undefined);
  };

  const submitWorkbookSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (modal?.kind !== 'workbook') return;
    const { workbook } = modal;
    const title = draft.title.trim();
    if (!title) return;
    // Only send what changed: a co-owner cannot see another owner's folder, so an
    // unchanged "No folder" must not unfile the workbook for everyone.
    const changes: { title?: string; folderId?: string | null } = {};
    if (title !== workbook.title) changes.title = title;
    if (draft.folderId !== settingsFolder(workbook)) changes.folderId = draft.folderId || null;
    if (!Object.keys(changes).length) { closeModal(); return; }
    await run(async () => {
      await request(`/api/v1/workbooks/${encodeURIComponent(workbook.id)}`, 'PATCH', changes);
      if (changes.folderId) setPrefs(current => ({ ...current, collapsed: current.collapsed.filter(id => id !== changes.folderId) }));
      setModal(null);
    }, { success: 'Workbook updated', inDialog: true });
  };

  const restoreWorkbook = (workbook: { id: string; title: string }) => {
    const index = trashRowIndex(workbook.id);
    return run(async () => {
    setRestoringId(workbook.id);
    try {
      await request(`/api/v1/workbooks/${encodeURIComponent(workbook.id)}/restore`, 'POST', {});
    } finally { setRestoringId(''); }
    if (routeRef.current.view.kind === 'trash') {
      await loadTrash();
      pendingFocus.current = trashFocus(index);
    }
    return { notice: `Restored “${workbook.title}”` };
  }, { pending: 'Restoring…' });
  };

  const deleteWorkbook = (workbook: Workbook) => void run(async () => {
    const result = await request(`/api/v1/workbooks/${encodeURIComponent(workbook.id)}`, 'DELETE') as { boards: number };
    setModal(null);
    openView({ kind: 'all' });
    pendingFocus.current = () => headingRef.current;
    return {
      notice: result.boards ? `Moved “${workbook.title}” and ${plural(result.boards, 'board')} to the trash` : `Moved “${workbook.title}” to the trash`,
      undo: () => void restoreWorkbook(workbook),
    };
  }, { inDialog: true, pending: 'Moving to trash…' });

  const submitNewWorkbook = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title) return;
    const folderId = draft.folderId;
    await run(async () => {
      const workbook = await request('/api/v1/workbooks', 'POST', { title, folderId: folderId || null }) as { id: string };
      if (folderId) setPrefs(current => ({ ...current, collapsed: current.collapsed.filter(id => id !== folderId) }));
      setModal(null);
      setWorkbookFilter('');
      openView({ kind: 'workbook', id: workbook.id });
      // Continue from the new workbook in the sidebar, or the page heading when the drawer is closed.
      pendingFocus.current = () => {
        const link = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('[data-workbook-id]') ?? []).find(item => item.dataset.workbookId === workbook.id);
        if (!link) return null;
        setActiveTreeRow(`workbook:${workbook.id}`);
        return visible(link) ? link : headingRef.current;
      };
    }, { success: 'Workbook created', inDialog: true });
  };

  const folderRow = (id: string) => Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('[data-folder-id]') ?? []).find(item => item.dataset.folderId === id) ?? null;

  const submitNewFolder = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title) return;
    await run(async () => {
      const folder = await request('/api/v1/folders', 'POST', { title }) as { id: string };
      setModal(null);
      setWorkbookFilter('');
      pendingFocus.current = () => {
        const row = folderRow(folder.id);
        if (!row) return null;
        setActiveTreeRow(`folder:${folder.id}`);
        return visible(row) ? row : headingRef.current;
      };
    }, { success: 'Folder created', inDialog: true });
  };

  const submitRenameFolder = async (event: FormEvent) => {
    event.preventDefault();
    if (modal?.kind !== 'rename-folder') return;
    const title = draft.title.trim();
    if (!title) return;
    const { folder } = modal;
    if (title === folder.title) { closeModal(); return; }
    await run(async () => {
      await request(`/api/v1/folders/${encodeURIComponent(folder.id)}`, 'PATCH', { title });
      setModal(null);
      pendingFocus.current = () => folderRow(folder.id);
    }, { success: 'Folder renamed', inDialog: true });
  };

  // Deleting a folder deletes no workbooks or boards, so it needs no confirmation: Undo puts everything back.
  const deleteFolder = (folder: Folder) => void run(async () => {
    const result = await request(`/api/v1/folders/${encodeURIComponent(folder.id)}`, 'DELETE') as { unfiled: number; workbookIds: string[]; folderIds: string[] };
    setPrefs(current => ({ ...current, collapsed: current.collapsed.filter(id => id !== folder.id) }));
    pendingFocus.current = () => sidebarRef.current?.querySelector<HTMLElement>('.workbook-list [data-tree-row][tabindex="0"]') ?? headingRef.current;
    return {
      notice: result.unfiled ? `Deleted “${folder.title}”. ${plural(result.unfiled, 'workbook')} ${agree(result.unfiled, 'is', 'are')} now unfiled.` : `Deleted “${folder.title}”`,
      undo: () => void run(async () => {
        await request(`/api/v1/folders/${encodeURIComponent(folder.id)}/restore`, 'POST', { workbookIds: result.workbookIds, folderIds: result.folderIds });
        pendingFocus.current = () => folderRow(folder.id);
      }, { success: `Restored “${folder.title}”`, pending: 'Restoring…' }),
    };
  }, { pending: 'Deleting folder…' });

  const toggleFolder = (id: string) => setPrefs(current => ({
    ...current,
    collapsed: current.collapsed.includes(id) ? current.collapsed.filter(item => item !== id) : [...current.collapsed, id],
  }));

  const loadTrash = async () => {
    setTrashLoading(true);
    setTrashFailed(false);
    try { setTrash(await request('/api/v1/trash') as Trash); }
    catch { setTrashFailed(true); }
    finally { setTrashLoading(false); }
  };
  useEffect(() => { if (route.view.kind === 'trash') void loadTrash(); }, [route.view.kind]);

  // What the grid shows.
  const searchActive = Boolean(route.query);
  const workbookRoles = useMemo(() => new Map(catalog.workbooks.map(workbook => [workbook.id, workbook.role])), [catalog.workbooks]);
  const placedFavorite = (board: Board) => board.id in placedFavorites ? placedFavorites[board.id] : board.favorite;
  const viewBoards = catalog.boards.filter(board => {
    if (route.view.kind === 'favorites') return placedFavorite(board);
    if (route.view.kind === 'shared') return sharedWithMe(board, workbookRoles);
    if (route.view.kind === 'workbook') return board.workbookId === route.view.id;
    if (route.view.kind === 'trash') return false;
    return true;
  });
  // Titles come straight from the catalog; note matches merge in when the server answers.
  // While a longer query is checked, earlier note matches stay if their excerpt still
  // matches, so results grow and settle instead of flickering. All follow the live catalog.
  const resultBoards = useMemo(() => {
    if (!searchActive) return [];
    const scoped = scopedWorkbookId ? catalog.boards.filter(board => board.workbookId === scopedWorkbookId) : catalog.boards;
    const titled = titleMatches(scoped, route.query).map(board => ({ ...board, matchedText: board.title }));
    const seen = new Set(titled.map(board => board.id));
    const needle = route.query.toLocaleLowerCase();
    const byId = new Map(scoped.map(board => [board.id, board]));
    // Settled results only use note matches for exactly this query and scope. While a new
    // note search is pending, earlier matches whose excerpt still contains the query stay.
    const usable = notes && (notes.key === searchKey || (notesPending && notes.workbookId === scopedWorkbookId)) ? notes.items : [];
    const noted = usable.flatMap(match => {
      const board = byId.get(match.id);
      if (!board || seen.has(board.id) || !match.excerpt?.toLocaleLowerCase().includes(needle)) return [];
      seen.add(board.id);
      return [{ ...board, matchedText: match.excerpt }];
    });
    return [...titled, ...noted];
  }, [searchActive, route.query, scopedWorkbookId, catalog.boards, notes, notesPending, searchKey]);
  const notesSettled = searchActive && !notesPending && (notes?.key === searchKey || route.query.length < NOTES_MIN_LENGTH);
  const notesStatus = notesSettled && notes?.key === searchKey ? notes.status : null;
  const notesUnavailable = notesStatus === 'failed' || notesStatus === 'limited';
  const shownBoards = searchActive ? resultBoards : viewBoards;
  const sort: SearchSort = searchActive ? searchSort : prefs.sort;
  const boardsById = new Map(shownBoards.map(board => [board.id, board]));
  // Sections use where each card was placed, not its live star, so starring never reorders mid-view.
  const sections = sectionBoards(shownBoards.map(board => ({ ...board, favorite: placedFavorite(board) })), sort, route.query, !searchActive && route.view.kind !== 'favorites')
    .map(section => ({ ...section, boards: section.boards.map(board => boardsById.get(board.id) ?? board) }));
  const workbookTitles = new Map(catalog.workbooks.map(workbook => [workbook.id, workbook.title]));
  const folderTitles = new Map(catalog.folders.map(folder => [folder.id, folder.title]));
  const missingWorkbook = !loading && !loadFailed && route.view.kind === 'workbook' && !activeWorkbook;
  const hero = route.view.kind === 'all' && !searchActive;
  const trashView = route.view.kind === 'trash' && !searchActive;

  const scopeLabel = activeWorkbook ? activeWorkbook.title : 'this workbook';
  const pageTitle = searchActive
    ? `Results for “${route.query}”`
    : route.view.kind === 'favorites' ? 'Favorites'
      : route.view.kind === 'shared' ? 'Shared with me'
        : route.view.kind === 'trash' ? 'Trash'
          : route.view.kind === 'workbook' ? activeWorkbook?.title ?? (loading ? 'Workbook' : 'Workbook unavailable')
            : 'All boards';
  const eyebrow = searchActive ? 'Search'
    : route.view.kind === 'workbook' ? (activeWorkbook?.folderId && folderTitles.get(activeWorkbook.folderId)) || 'Workbook'
      : route.view.kind === 'shared' ? 'Together'
        : route.view.kind === 'favorites' ? 'Close at hand'
          : studioTitle() ?? PRODUCT_NAME;
  const workbookDescription = (workbook: Workbook) => {
    if (workbook.id === 'workbook:shared') return 'Boards people shared with you one at a time.';
    if (workbook.role === 'owner') return '';
    const access = roleLabel(workbook.role).toLowerCase();
    return access ? `Shared with you · you ${access === 'view only' ? 'can view' : access}` : 'Shared with you';
  };
  const pageDescription = searchActive
    ? scopedWorkbookId ? `Board names and notes in ${scopeLabel}` : 'Board names and notes across your studio'
    : route.view.kind === 'favorites' ? 'Boards you starred, one click away.'
      : route.view.kind === 'shared' ? 'Boards that reach you through other people’s sharing.'
        : route.view.kind === 'trash' ? 'Things you move to the trash stay here until you restore them.'
          : activeWorkbook ? workbookDescription(activeWorkbook)
            : route.view.kind === 'workbook' ? ''
              : 'A place for the ideas you’re working on.';

  useEffect(() => { document.title = `${pageTitle} — ${studioTitle() ?? PRODUCT_NAME}`; }, [pageTitle]);

  const tree = workbookTree(catalog.folders, catalog.workbooks, workbookFilter);
  const boardCounts = new Map<string, number>();
  for (const board of catalog.boards) if (board.workbookId) boardCounts.set(board.workbookId, (boardCounts.get(board.workbookId) ?? 0) + 1);

  // The workbook tree is one tab stop; arrow keys move, open and close, as in a WAI-ARIA tree.
  const treeRows: Array<{ id: string; folderId?: string; parent?: string }> = [];
  if (!tree.filtering) for (const { folder, workbooks } of tree.folders) {
    treeRows.push({ id: `folder:${folder.id}`, folderId: folder.id });
    if (!prefs.collapsed.includes(folder.id)) for (const workbook of workbooks) treeRows.push({ id: `workbook:${workbook.id}`, parent: `folder:${folder.id}` });
  }
  else for (const { workbooks } of tree.folders) for (const workbook of workbooks) treeRows.push({ id: `workbook:${workbook.id}` });
  for (const workbook of tree.unfiled) treeRows.push({ id: `workbook:${workbook.id}` });
  const currentTreeRow = treeRows.some(row => row.id === activeTreeRow) ? activeTreeRow
    : treeRows.find(row => row.id === `workbook:${route.view.kind === 'workbook' ? route.view.id : ''}`)?.id ?? treeRows[0]?.id ?? '';
  const focusTreeRow = (id: string) => {
    const row = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('[data-tree-row]') ?? []).find(item => item.dataset.treeRow === id);
    if (!row) return;
    setActiveTreeRow(id);
    row.focus();
  };
  const treeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const id = target.dataset.treeRow;
    if (!id || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = treeRows.findIndex(row => row.id === id);
    const row = treeRows[index];
    if (!row) return;
    const expanded = row.folderId ? !prefs.collapsed.includes(row.folderId) : false;
    let next = '';
    if (event.key === 'ArrowDown') next = treeRows[index + 1]?.id ?? '';
    else if (event.key === 'ArrowUp') next = treeRows[index - 1]?.id ?? '';
    else if (event.key === 'Home') next = treeRows[0]?.id ?? '';
    else if (event.key === 'End') next = treeRows.at(-1)?.id ?? '';
    else if (event.key === 'ArrowRight' && row.folderId) {
      event.preventDefault();
      if (!expanded) toggleFolder(row.folderId);
      else if (treeRows[index + 1]?.parent === row.id) focusTreeRow(treeRows[index + 1].id);
      return;
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (row.folderId && expanded) toggleFolder(row.folderId);
      else if (row.parent) focusTreeRow(row.parent);
      return;
    } else return;
    event.preventDefault();
    if (next) focusTreeRow(next);
  };

  const workbookItem = (workbook: Workbook) => {
    const current = activeKey === `workbook:${workbook.id}`;
    const rowId = `workbook:${workbook.id}`;
    return (
      <li key={workbook.id}>
        <a className="tree-item" {...viewLink({ kind: 'workbook', id: workbook.id })} aria-current={current ? 'page' : undefined} title={workbook.title} data-workbook-id={workbook.id} data-tree-row={rowId} tabIndex={rowId === currentTreeRow ? 0 : -1} onFocus={() => setActiveTreeRow(rowId)}>
          <WorkbookGlyph />
          <span className="tree-label">{workbook.title}</span>
          <b>{boardCounts.get(workbook.id) ?? 0}</b>
        </a>
      </li>
    );
  };

  const navItem = (view: StudioView, icon: 'templates' | 'star' | 'share', label: string, count?: number) => (
    <a className="nav-item" {...viewLink(view)} aria-current={activeKey === viewKey(view) && !searchActive ? 'page' : undefined}>
      <UiIcon name={icon} />
      <span className="tree-label">{label}</span>
      {count === undefined || loading || loadFailed ? <b aria-hidden="true" /> : <b>{count}</b>}
    </a>
  );

  const emptyState = (): ReactNode => {
    if (searchActive && !notesSettled) return (
      <section className="workspace-empty compact searching" aria-labelledby="empty-title">
        <div className="studio-empty-symbol" aria-hidden="true">{notesPending ? <i className="empty-spinner" /> : <UiIcon name="search" />}</div>
        <div className="studio-empty-copy">
          <h2 id="empty-title">{notesPending ? 'Searching notes…' : `No board names match “${route.query}”`}</h2>
          <p>{notesPending ? `No board names match “${route.query}”. Looking through note text${scopedWorkbookId ? ` in ${scopeLabel}` : ''}.` : 'Press Enter to search note text as well.'}</p>
        </div>
      </section>
    );
    if (searchActive) return (
      <section className="workspace-empty compact" aria-labelledby="empty-title">
        <div className="studio-empty-symbol" aria-hidden="true"><UiIcon name="search" /></div>
        <div className="studio-empty-copy">
          <h2 id="empty-title">{notesUnavailable ? `No board names match “${route.query}”` : `No boards match “${route.query}”`}</h2>
          <p>{notesUnavailable ? 'Note text couldn’t be searched just now, so this may not be everything.'
            : notes?.key !== searchKey ? 'No board names match. Press Enter to search note text too.'
              : scopedWorkbookId ? `This search only looked in ${scopeLabel}. Try all of your boards, or a phrase from a note.` : 'Try a different board name, or a phrase you remember from a note.'}</p>
          <div className="empty-actions">
            {notesUnavailable ? <button type="button" onClick={() => searchNotesNow(route)}>Search notes again</button> : null}
            {scopedWorkbookId && !notesUnavailable ? <button type="button" onClick={() => setScope('all')}>Search all boards</button> : null}
            <button className={scopedWorkbookId || notesUnavailable ? 'quiet' : ''} type="button" onClick={() => { setQueryInput(''); leaveSearch(); searchRef.current?.focus(); }}>Clear search</button>
          </div>
        </div>
      </section>
    );
    if (missingWorkbook) return (
      <section className="workspace-empty compact" aria-labelledby="empty-title">
        <div className="studio-empty-symbol" aria-hidden="true"><WorkbookGlyph /></div>
        <div className="studio-empty-copy">
          <h2 id="empty-title">You don’t have access to this workbook</h2>
          <p>If someone meant to share it, ask them to invite you. If it was yours, it may be in the Trash.</p>
          <div className="empty-actions"><a className="empty-link-button" {...viewLink({ kind: 'all' })}>Go to all boards</a><a className="empty-link-button quiet" {...viewLink({ kind: 'trash' })}>Open Trash</a></div>
        </div>
      </section>
    );
    if (route.view.kind === 'favorites') return (
      <section className="workspace-empty compact" aria-labelledby="empty-title">
        <div className="studio-empty-symbol" aria-hidden="true"><UiIcon name="star" /></div>
        <div className="studio-empty-copy">
          <h2 id="empty-title">No favorites yet</h2>
          <p>Star a board, or choose Add to favorites from its menu, to keep it here.</p>
          <div className="empty-actions"><a className="empty-link-button" {...viewLink({ kind: 'all' })}>Browse all boards</a></div>
        </div>
      </section>
    );
    if (activeWorkbook) {
      const editable = activeWorkbook.role === 'owner' || activeWorkbook.role === 'editor';
      return (
        <section className="workspace-empty compact" aria-labelledby="empty-title">
          <div className="studio-empty-symbol" aria-hidden="true"><UiIcon name="sticky" /></div>
          <div className="studio-empty-copy">
            <h2 id="empty-title">This workbook is empty</h2>
            <p>{editable ? 'Add a board to start collecting related ideas here.' : 'Boards added to this workbook will appear here.'}</p>
            {editable ? <div className="empty-actions"><button type="button" onClick={openCreate}><UiIcon name="plus" />New board</button></div> : null}
          </div>
        </section>
      );
    }
    const shared = route.view.kind === 'shared' || !canAddBoards;
    return (
      <section className="workspace-empty" aria-labelledby="empty-title">
        <div className={`studio-empty-art${shared ? ' collaboration' : ''}`} aria-hidden="true"><ThemedImage light={shared ? '/brand/huddle.webp' : '/brand/first-idea.webp'} dark={shared ? '/brand/huddle-dark.webp' : '/brand/first-idea-dark.webp'} alt="" width="1254" height="1254" loading="lazy" /></div>
        <div className="studio-empty-copy">
          <h2 id="empty-title">{shared ? 'Nothing shared with you yet' : 'Start with one idea'}</h2>
          <p>{shared ? 'When someone invites you to a board or workbook, it appears here. Open their invitation link to join in.' : 'A note, a sketch, a question. Put it on a board and see where it leads.'}</p>
          {!shared ? <div className="empty-actions">
            <button type="button" onClick={openCreate}><UiIcon name="plus" />Create your first board</button>
            <button className="quiet" type="button" onClick={() => importRef.current?.click()} disabled={busy}>Import a board archive</button>
          </div> : null}
        </div>
      </section>
    );
  };

  const modalTitleId = 'studio-dialog-title';
  const field = (key: 'title' | 'folderId' | 'workbookId') => ({
    value: draft[key],
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft(current => ({ ...current, [key]: event.target.value })),
  });
  const folderOptions = catalog.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.title}</option>);
  const workbookOptions = (items: Workbook[]) => {
    const grouped = workbookTree(catalog.folders, items, '');
    const filed = grouped.folders.filter(group => group.workbooks.length);
    const unfiled = grouped.unfiled.map(item => <option key={item.id} value={item.id}>{item.title}</option>);
    return <>
      {filed.map(group => (
        <optgroup key={group.folder.id} label={group.folder.title}>
          {group.workbooks.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </optgroup>
      ))}
      {filed.length && unfiled.length ? <optgroup label="No folder">{unfiled}</optgroup> : unfiled}
    </>;
  };

  const itemProps = (board: Board): BoardItemProps => ({
    board,
    query: searchActive ? route.query : '',
    workbookTitle: board.workbookId ? workbookTitles.get(board.workbookId) : undefined,
    showWorkbook: route.view.kind !== 'workbook' || searchActive,
    showRole: searchActive || !activeWorkbook || board.role !== activeWorkbook.role,
    showExcerpt: searchActive,
    highlighted: highlighted === board.id,
    canDuplicate: (board.role === 'owner' || board.role === 'editor') && editableWorkbooks.some(item => item.id === board.workbookId),
    canMove: board.role === 'owner' && editableWorkbooks.some(item => item.id !== board.workbookId),
    onOpen: event => {
      if (!plainClick(event)) return;
      try { sessionStorage.setItem(studioSessionKey('return-card', profile?.id), JSON.stringify({ id: board.id, href: `${location.pathname}${location.search}`, scrollY: window.scrollY })); } catch { /* Storage may be unavailable. */ }
    },
    onFavorite: fromMenu => toggleFavorite(board, fromMenu),
    onRename: () => openModal({ kind: 'rename', board }, { title: board.title }),
    onMove: () => openModal({ kind: 'move', board }),
    onDuplicate: () => duplicateBoard(board),
    onExport: () => exportBoard(board),
    // Trash is reversible: no confirmation, an Undo notice instead.
    onTrash: () => trashBoard(board),
  });

  const layoutToggle = (
    <div className="layout-toggle" role="group" aria-label="Layout">
      {(['grid', 'list'] as BoardLayout[]).map(layout => (
        <button key={layout} type="button" aria-pressed={prefs.layout === layout} aria-label={layout === 'grid' ? 'Grid view' : 'List view'} title={layout === 'grid' ? 'Grid view' : 'List view'} onClick={() => setPrefs(current => ({ ...current, layout }))}>
          <UiIcon name={layout === 'grid' ? 'templates' : 'menu'} />
        </button>
      ))}
    </div>
  );

  return (
    <div className="workspace-shell" onClickCapture={event => {
      if (modal) return;
      const control = event.target instanceof Element ? event.target.closest<HTMLElement>('button, summary, a[href]') : null;
      if (control) dialogTrigger.current = control;
    }}>
      <a className="skip-link" href="#studio-main" onClick={event => { event.preventDefault(); document.getElementById('studio-main')?.focus(); }}>Skip to main content</a>
      <aside ref={sidebarRef} className={`workspace-sidebar${catalog.workbooks.length + catalog.folders.length > 10 ? ' dense' : ''}`} data-onboarding="organize" aria-label="Studio">
        <a className="workspace-logo" {...viewLink({ kind: 'all' })} aria-label={`${PRODUCT_NAME} home`}>
          <BrandMark />
          <span className="workspace-brand-copy"><span className="brand-wordmark">{PRODUCT_WORDMARK}</span></span>
        </a>
        <button ref={menuToggleRef} className="studio-menu-toggle" type="button" aria-label="Studio navigation" aria-expanded={navigationOpen} aria-controls="studio-navigation" onClick={toggleNavigation}><UiIcon name={navigationOpen ? 'close' : 'menu'} /></button>

        {/* The slot is held while loading so the navigation never jumps when the button arrives. */}
        {loading ? <span className="new-board-button placeholder" aria-hidden="true" /> : canAddBoards ? <button data-onboarding="new-board" className="new-board-button" type="button" onClick={openCreate}>
          <UiIcon name="plus" /> New board
        </button> : null}

        <div id="studio-navigation" className={`studio-navigation${navigationOpen ? ' open' : ''}`}>
          <nav className="sidebar-nav" aria-label="Board views">
            {navItem({ kind: 'all' }, 'templates', 'All boards', catalog.boards.length)}
            {navItem({ kind: 'favorites' }, 'star', 'Favorites', catalog.boards.filter(board => board.favorite).length)}
            {navItem({ kind: 'shared' }, 'share', 'Shared with me', catalog.boards.filter(board => sharedWithMe(board, workbookRoles)).length)}
          </nav>

          <nav className="sidebar-section" aria-labelledby="workbooks-heading">
            <div className="sidebar-section-heading">
              <span className="sidebar-section-title" id="workbooks-heading">Workbooks</span>
              {canCreate ? <DetailsMenu className="sidebar-add-menu">
                <summary aria-label="Add a workbook or folder" title="Add a workbook or folder"><UiIcon name="plus" /></summary>
                <div className="sidebar-add-popover">
                  <button type="button" onClick={() => openModal({ kind: 'new-workbook' }, { folderId: activeWorkbook?.folderId ?? '' })}><UiIcon name="templates" />New workbook</button>
                  <button type="button" onClick={() => openModal({ kind: 'new-folder' })}><UiIcon name="folder" />New folder</button>
                </div>
              </DetailsMenu> : null}
            </div>
            {catalog.workbooks.length >= WORKBOOK_FILTER_THRESHOLD || workbookFilter ? <label className="workbook-search"><UiIcon name="search" /><input type="search" aria-label="Find workbooks" placeholder="Find a workbook" value={workbookFilter} onChange={event => setWorkbookFilter(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && workbookFilter) { event.preventDefault(); event.stopPropagation(); setWorkbookFilter(''); } }} /></label> : null}
            <div className="workbook-list" onKeyDown={treeKeyDown}>
              {tree.filtering && tree.empty ? <p className="sidebar-empty" role="status">No workbooks match “{workbookFilter.trim()}”.</p> : null}
              {loading ? <div className="sidebar-skeleton" aria-hidden="true"><span /><span /><span /></div> : null}
              {!loading && !loadFailed && !catalog.workbooks.length ? <div className="sidebar-empty">
                <p>Workbooks keep related boards together.</p>
                {canCreate ? <button type="button" className="sidebar-text-button" onClick={() => openModal({ kind: 'new-workbook' })}>Create a workbook</button> : null}
              </div> : null}
              {tree.folders.length ? <ul className="tree">
                {tree.folders.map(({ folder, workbooks, total }) => {
                  const expanded = tree.filtering || !prefs.collapsed.includes(folder.id);
                  const holdsCurrent = !expanded && route.view.kind === 'workbook' && workbooks.some(item => item.id === (route.view as { id: string }).id);
                  const rowId = `folder:${folder.id}`;
                  const rowActive = rowId === currentTreeRow;
                  return (
                    <li className="tree-folder" key={folder.id}>
                      {tree.filtering ? (
                        <div className="folder-row static" title={folder.title}><UiIcon name="folder" /><span className="tree-label">{folder.title}</span></div>
                      ) : (
                        <div className="folder-line">
                          <button className={`folder-row${holdsCurrent ? ' has-current' : ''}`} type="button" aria-expanded={expanded} aria-controls={`folder-${folder.id}`} title={folder.title} data-folder-id={folder.id} data-tree-row={rowId} tabIndex={rowActive ? 0 : -1} onFocus={() => setActiveTreeRow(rowId)} onClick={() => toggleFolder(folder.id)}>
                            <UiIcon name="chevron" className="folder-chevron" />
                            <UiIcon name="folder" />
                            <span className="tree-label">{folder.title}</span>
                            {holdsCurrent ? <i className="current-dot" aria-hidden="true" /> : null}
                            {holdsCurrent ? <span className="visually-hidden">, contains the open workbook</span> : null}
                          </button>
                          <DetailsMenu className="folder-menu" floating>
                            <summary aria-label={`Actions for folder ${folder.title}`} title="Folder actions" tabIndex={rowActive ? 0 : -1}><UiIcon name="more" /></summary>
                            <div className="sidebar-add-popover">
                              {canCreate ? <button type="button" onClick={() => openModal({ kind: 'new-workbook' }, { folderId: folder.id })}><UiIcon name="plus" />New workbook here</button> : null}
                              <button type="button" onClick={() => openModal({ kind: 'rename-folder', folder }, { title: folder.title })}><UiIcon name="pen" />Rename folder…</button>
                              <button className="danger-action" type="button" onClick={() => deleteFolder(folder)}><UiIcon name="trash" />Delete folder</button>
                            </div>
                          </DetailsMenu>
                        </div>
                      )}
                      <div id={`folder-${folder.id}`} hidden={!expanded}>
                        {expanded ? (
                          workbooks.length ? <ul className="tree-children">{workbooks.map(workbookItem)}</ul>
                            : total === 0 ? <p className="tree-empty">No workbooks yet{canCreate ? <> · <button type="button" className="sidebar-text-button" onClick={() => openModal({ kind: 'new-workbook' }, { folderId: folder.id })}>Add one</button></> : null}</p> : null
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul> : null}
              {tree.unfiled.length ? <>
                {tree.folders.length ? <p className="tree-group-label">Unfiled</p> : null}
                <ul className="tree">{tree.unfiled.map(workbookItem)}</ul>
              </> : null}
            </div>
          </nav>

          <div className="sidebar-footer">
            <a className="studio-footer-link nav-trash" {...viewLink({ kind: 'trash' })} aria-current={route.view.kind === 'trash' ? 'page' : undefined} data-tip="Trash"><UiIcon name="trash" /><span className="footer-label">Trash</span></a>
            <a className="studio-footer-link" data-onboarding="connections" href="/settings/connections" data-tip="Connected apps"><UiIcon name="apps" /><span className="footer-label">Connected apps</span></a>
            <button className="studio-footer-link" type="button" data-tip="Quick tour" onClick={() => { setNavigationOpen(false); openTour(); }}><UiIcon name="help" /><span className="footer-label">Quick tour</span></button>
            {canAddBoards || loading ? <button className="studio-footer-link" type="button" data-tip="Import board archive" onClick={() => importRef.current?.click()} disabled={busy || loading}>
              <UiIcon name="import" /><span className="footer-label">Import board archive</span>
            </button> : null}
            <div className="studio-signature"><MarkerTagline signature /></div>
          </div>
        </div>
        {canAddBoards ? <input ref={importRef} className="visually-hidden" type="file" tabIndex={-1} aria-hidden="true" accept=".json,.whiteboard.json,application/json,application/vnd.personal-whiteboard+json" onChange={importArchive} /> : null}
      </aside>

      {/* On phones the open drawer sits over the page; a tap outside only closes it. */}
      {navigationOpen ? <div className="studio-scrim" aria-hidden="true" onClick={() => setNavigationOpen(false)} /> : null}
      <main className="workspace-main" id="studio-main" tabIndex={-1}>
        <header className="workspace-topbar">
          <form data-onboarding="search" className="workspace-search" role="search" onSubmit={event => { event.preventDefault(); searchNotesNow(commitQuery(queryInput)); }}>
            <span className="search-icon"><UiIcon name="search" /></span>
            <input
              ref={searchRef}
              type="text"
              aria-label="Search boards and notes"
              aria-keyshortcuts="/ Control+K Meta+K"
              maxLength={MAX_QUERY_LENGTH}
              value={queryInput}
              enterKeyHint="search"
              onChange={event => setQueryInput(event.target.value)}
              onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                if (queryInput || route.query) { setQueryInput(''); leaveSearch(); }
                else event.currentTarget.blur();
              }}
              placeholder="Search boards and notes"
            />
            {queryInput ? (
              <button
                className="search-clear"
                type="button"
                aria-label="Clear search"
                onClick={() => { setQueryInput(''); leaveSearch(); searchRef.current?.focus(); }}
              >
                <UiIcon name="close" />
              </button>
            ) : (
              <kbd aria-hidden="true" title="Press / to search">/</kbd>
            )}
          </form>
          <div data-onboarding="account" className="workspace-account-actions"><ThemeMenu />
            <button ref={notificationsTrigger} aria-expanded={showNotifications} className="notification-button" type="button" aria-label={notifications.some(item => !item.readAt) ? 'Notifications, unread' : 'Notifications'} onClick={() => { setShowNotifications(value => !value); setShowAccount(false); }}><UiIcon name="bell" />{notifications.some(item => !item.readAt) ? <i /> : null}</button>
            <button ref={accountTrigger} aria-expanded={showAccount} className={`workspace-profile${profile ? '' : ' loading'}`} type="button" style={profile ? { background: profile.color, color: avatarInk(profile.color) } : undefined} title="Account settings" aria-label="Account settings" onClick={() => {
              setShowAccount(value => !value);
              setShowNotifications(false);
            }}>{profile?.name.slice(0, 1).toUpperCase() ?? ''}</button>
            {showNotifications ? <aside ref={notificationsRef} className="notification-popover" aria-labelledby="notifications-title">
              <header><h2 id="notifications-title" ref={notificationsHeading} tabIndex={-1}>Notifications</h2></header>
              {notifications.length ? <div className="notification-list">{notifications.map(item => <a className={item.readAt ? '' : 'unread'} key={item.id} href={item.href ?? '#'} onClick={() => {
                setNotifications(items => items.map(entry => entry.id === item.id ? { ...entry, readAt: entry.readAt ?? new Date().toISOString() } : entry));
                void request(`/api/v1/notifications/${encodeURIComponent(item.id)}/read`, 'POST').catch(() => undefined);
              }}><b>{item.title}</b><span>{item.body}</span><small title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt)}</small></a>)}</div> : <p>You’re all caught up.</p>}
              <footer>
                {notifications.some(item => !item.readAt) ? <button type="button" onClick={() => void request('/api/v1/notifications/read-all', 'POST').then(() => setNotifications(items => items.map(item => ({ ...item, readAt: new Date().toISOString() }))))}><UiIcon name="check" />Mark all as read</button> : <span />}
                <button type="button" onClick={() => { setShowNotifications(false); notificationsTrigger.current?.focus(); }}>Close</button>
              </footer>
            </aside> : null}
            {showAccount ? <aside ref={accountRef} className="account-popover" aria-label="Account settings">
              <header><div><strong>{profile?.name}</strong><span>{profile?.email}</span></div><button type="button" aria-label="Close account settings" onClick={() => setShowAccount(false)}><UiIcon name="close" /></button></header>
              <form onSubmit={event => {
                event.preventDefault();
                void run(async () => {
                  const value = await request('/api/v1/me', 'PATCH', { name: profileName, color: profileColor }) as { user: Profile };
                  setProfile(value.user);
                }, { success: 'Profile updated' });
              }}>
                <label><span>Display name</span><input value={profileName} maxLength={80} onChange={event => setProfileName(event.target.value)} /></label>
                <MarkerColorField value={profileColor} onChange={setProfileColor} />
                <button className="primary-button" type="submit" disabled={busy || !profileName.trim()}>Save profile</button>
              </form>
              {authSnapshot()?.mode === 'native' && <a className="account-connections" href="/settings/account">{['owner','admin'].includes(authSnapshot()?.account?.role ?? '') ? 'Account and administration' : 'Account and security'} <span aria-hidden="true">↗</span></a>}
              <a className="account-connections" href="/settings/connections">Manage connected apps <span aria-hidden="true">↗</span></a>
              {authSnapshot()?.mode === 'native' ? <button type="button" className="account-signout" disabled={busy} onClick={()=>void run(async()=>{await api('/api/auth/sign-out',{});},{ success: 'Signed out' })}>Sign out</button> : profile?.authentication === 'cloudflare-access' ? <a className="account-signout" href="/cdn-cgi/access/logout">Sign out</a> : <span className="account-environment">Local development identity</span>}
            </aside> : null}
          </div>
        </header>

        <div className="workspace-content">
          <div className={`workspace-heading${hero ? ' hero' : ' compact'}`}>
            <div className="heading-copy">
              <span className="studio-eyebrow">{activeWorkbook?.folderId && !searchActive ? <UiIcon name="folder" /> : null}<span>{eyebrow}</span></span>
              <h1 id="studio-title" ref={headingRef} tabIndex={-1} title={activeWorkbook && !searchActive ? activeWorkbook.title : undefined}>{pageTitle}</h1>
              {pageDescription ? <p>{pageDescription}</p> : null}
            </div>
            {activeWorkbook?.role === 'owner' && !searchActive ? <div className="heading-actions">
              <button className="secondary-button" type="button" onClick={() => setSharingWorkbook(activeWorkbook)}><UiIcon name="share" />Share</button>
              <button className="secondary-button icon-only" type="button" aria-label="Workbook settings" title="Workbook settings" onClick={() => openWorkbookSettings(activeWorkbook)}><UiIcon name="settings" /></button>
            </div> : null}
          </div>

          {error && !modal ? (
            <div className="message-banner error-banner" role="alert">
              <span>{error}</span>
              <button type="button" aria-label="Dismiss error" onClick={() => setError('')}><UiIcon name="close" /></button>
            </div>
          ) : null}

          {!loading && !loadFailed && !trashView && (shownBoards.length > 0 || (searchActive && (notesPending || (route.view.kind === 'workbook' && activeWorkbook)))) ? (
            <div className="board-collection-toolbar">
              {searchActive && route.view.kind === 'workbook' && activeWorkbook ? (
                <div className="search-scope" role="group" aria-labelledby="search-scope-label">
                  <span className="search-scope-label" id="search-scope-label">Search in</span>
                  <button type="button" aria-pressed={route.scope === 'view'} title={activeWorkbook.title} onClick={() => setScope('view')}><UiIcon name="folder" /><span>{activeWorkbook.title}</span></button>
                  <button type="button" aria-pressed={route.scope === 'all'} onClick={() => setScope('all')}><UiIcon name="templates" /><span>All boards</span></button>
                </div>
              ) : null}
              {searchActive ? <>
                <span className="collection-count">
                  {shownBoards.length ? plural(shownBoards.length, 'board') : ''}
                  {/* With no results yet, the empty state already says it is searching. */}
                  {notesPending && shownBoards.length ? <span className="notes-pending"><i aria-hidden="true" />Checking notes…</span> : null}
                </span>
                {/* Announce once results settle, not on every keystroke. */}
                <span className="visually-hidden" role="status" aria-live="polite">{notesSettled ? (shownBoards.length ? `${plural(shownBoards.length, 'matching board')} for “${route.query}”` : `No matching boards for “${route.query}”`) : ''}</span>
              </> : <span className="collection-count" role="status">{plural(shownBoards.length, 'board')}</span>}
              {shownBoards.length > 1 ? <label className="sort-control"><span>Sort</span><select aria-label="Sort boards" value={sort} onChange={event => {
                const value = event.target.value as SearchSort;
                if (searchActive) setSearchSort(value);
                else setPrefs(current => ({ ...current, sort: value === 'name' ? 'name' : 'recent' as BrowseSort }));
              }}>
                {searchActive ? <option value="relevance">Best match</option> : null}
                <option value="recent">Recently edited</option>
                <option value="name">Name</option>
              </select></label> : null}
              {shownBoards.length ? layoutToggle : null}
            </div>
          ) : null}

          {notesUnavailable && shownBoards.length ? (
            <p className="search-hint above">
              <UiIcon name="help" />
              <span>{notesStatus === 'limited' ? 'Note search needs a moment. These results match board names only.' : 'Note text couldn’t be searched just now. These results match board names only.'}</span>
              <button type="button" onClick={() => searchNotesNow(route)}>Search notes again</button>
            </p>
          ) : null}

          {loadFailed ? (
            <section className="workspace-empty compact" aria-labelledby="empty-title" role="alert">
              <div className="studio-empty-symbol" aria-hidden="true"><UiIcon name="history" /></div>
              <div className="studio-empty-copy">
                <h2 id="empty-title">Your boards didn’t load</h2>
                <p>Check your connection and try again. If the server was just updated or restarted, it may need a moment.</p>
                <div className="empty-actions"><button type="button" onClick={() => void loadWorkspace()}>Try again</button></div>
              </div>
            </section>
          ) : loading ? (
            <div className={prefs.layout === 'list' ? 'board-list skeleton-list' : 'board-grid'} aria-busy="true" aria-label="Loading boards">
              {[0, 1, 2, 3].map(item => prefs.layout === 'list'
                ? <div className="board-row board-skeleton" key={item}><span /><span /></div>
                : <div className="board-card board-skeleton" key={item}><span className="skeleton-preview" /><span className="skeleton-line" /><span className="skeleton-line short" /></div>)}
            </div>
          ) : trashView ? (
            <StudioTrash trash={trash} loading={trashLoading} failed={trashFailed} busyId={restoringId} onRetry={() => void loadTrash()}
              onRestoreBoard={board => board.workbookDeletedAt ? openModal({ kind: 'restore', board }) : void restoreBoard(board)}
              onRestoreWorkbook={workbook => void restoreWorkbook(workbook)} />
          ) : shownBoards.length > 0 ? (
            <BoardCollection sections={sections} layout={prefs.layout} activeId={activeCard} onActive={setActiveCard} itemProps={itemProps} />
          ) : emptyState()}

          {notesStatus === 'partial' ? (
            <p className="search-hint">
              <UiIcon name="help" />
              <span>Note text was checked in your most recently edited boards. Add a word or two to narrow it down.</span>
            </p>
          ) : null}
        </div>
      </main>

      <div className="toast-region" role="status" aria-live="polite" onMouseEnter={() => setNoticeHeld(true)} onMouseLeave={() => setNoticeHeld(false)} onFocus={() => setNoticeHeld(true)} onBlur={() => setNoticeHeld(false)}>
        {notice ? (
          <div className={`toast-message${notice.pending ? ' pending' : ''}`} key={notice.id}>
            {notice.pending ? <i className="button-spinner" aria-hidden="true" /> : <UiIcon name="check" />}
            <span>{notice.text}</span>
            {notice.action ? <button type="button" className="toast-action" aria-keyshortcuts="Control+Z Meta+Z" onClick={() => { const action = notice.action!; setNotice(null); setNoticeHeld(false); action.run(); }}>{notice.action.label}</button> : null}
          </div>
        ) : null}
      </div>
      {sharingWorkbook ? <ShareDialog workbookId={sharingWorkbook.id} onClose={() => setSharingWorkbook(null)} /> : null}

      {modal ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeModal();
        }}>
          <section ref={dialogRef} tabIndex={-1} className={`workspace-modal${modal.kind === 'move' || modal.kind === 'restore' ? ' move-dialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby={modalTitleId}>
            <button className="modal-close" type="button" aria-label="Close" onClick={closeModal}><UiIcon name="close" /></button>
            {modal.kind === 'workbook' ? <form onSubmit={submitWorkbookSettings}>
              <h2 id={modalTitleId}>Workbook settings</h2>
              <p>{catalog.folders.length ? 'Rename this workbook or file it in one of your folders. Sharing stays the same.' : 'Rename this workbook. Sharing stays the same.'}</p>
              <DialogError message={dialogError} />
              <label><span>Workbook name</span><SelectedInput maxLength={120} required {...field('title')} /></label>
              {catalog.folders.length || modal.workbook.filedElsewhere ? <>
                <label><span>Folder</span><select {...field('folderId')} aria-describedby={modal.workbook.filedElsewhere || coOwned ? 'folder-hint' : undefined}>
                  {modal.workbook.filedElsewhere ? <option value={FILED_ELSEWHERE}>In another owner’s folder</option> : null}
                  <option value="">No folder</option>{folderOptions}
                </select></label>
                {modal.workbook.filedElsewhere && draft.folderId !== FILED_ELSEWHERE
                  ? <small className="field-hint warning" id="folder-hint">This moves it out of the other owner’s folder for everyone who owns it.</small>
                  : modal.workbook.filedElsewhere
                    ? <small className="field-hint" id="folder-hint">Another owner keeps this workbook in one of their folders, so it shows as unfiled for you.</small>
                    : coOwned
                      ? <small className="field-hint" id="folder-hint">Folders are yours. A workbook sits in one folder for all its owners; moving it also moves it for co-owners.</small>
                      : null}
              </> : null}
              <div className="modal-actions split">
                <button className="text-danger-button" type="button" onClick={() => openModal({ kind: 'delete-workbook', workbook: modal.workbook, boards: boardCounts.get(modal.workbook.id) ?? 0 })}><UiIcon name="trash" />Delete workbook…</button>
                <span className="modal-actions-end"><button className="secondary-button" type="button" onClick={closeModal}>Cancel</button>
                  <button className="primary-button" type="submit" disabled={busy || !draft.title.trim()}>Save changes</button></span>
              </div>
            </form> : null}

            {modal.kind === 'delete-workbook' ? (
              <div>
                <div className="modal-icon trash-icon"><UiIcon name="trash" /></div>
                <h2 id={modalTitleId}>Move “{modal.workbook.title}” to the trash?</h2>
                <p>{modal.boards
                  ? `Its ${plural(modal.boards, 'board')} ${agree(modal.boards, 'goes', 'go')} to the trash with it. Restoring the workbook from Trash brings ${modal.boards === 1 ? 'that board' : 'those boards'} back with it.`
                  : 'You can restore it from Trash.'} Nothing is deleted for good.</p>
                <DialogError message={dialogError} />
                <div className="modal-actions">
                  <AutoFocusButton className="secondary-button" type="button" onClick={closeModal}>Keep workbook</AutoFocusButton>
                  <button className="danger-button" type="button" disabled={busy} onClick={() => deleteWorkbook(modal.workbook)}><UiIcon name="trash" />Move to trash</button>
                </div>
              </div>
            ) : null}

            {modal.kind === 'new-workbook' ? <form onSubmit={submitNewWorkbook}>
              <div className="modal-icon create-icon"><WorkbookGlyph /></div>
              <h2 id={modalTitleId}>New workbook</h2>
              <p>Workbooks keep related boards together, and can be shared as a whole.</p>
              <DialogError message={dialogError} />
              <label><span>Workbook name</span><SelectedInput maxLength={120} placeholder="Project planning" required {...field('title')} /></label>
              {catalog.folders.length ? <label><span>Folder</span><select {...field('folderId')}>
                <option value="">No folder</option>{folderOptions}
              </select></label> : null}
              <div className="modal-actions"><button className="secondary-button" type="button" onClick={closeModal}>Cancel</button>
                <button className="primary-button" type="submit" disabled={busy || !draft.title.trim()}>Create workbook</button></div>
            </form> : null}

            {modal.kind === 'new-folder' ? <form onSubmit={submitNewFolder}>
              <div className="modal-icon create-icon"><UiIcon name="folder" /></div>
              <h2 id={modalTitleId}>New folder</h2>
              <p>Folders organize your workbooks in the sidebar. Only you see your folders.</p>
              <DialogError message={dialogError} />
              <label><span>Folder name</span><SelectedInput maxLength={120} placeholder="Work" required {...field('title')} /></label>
              <div className="modal-actions"><button className="secondary-button" type="button" onClick={closeModal}>Cancel</button>
                <button className="primary-button" type="submit" disabled={busy || !draft.title.trim()}>Create folder</button></div>
            </form> : null}

            {modal.kind === 'rename-folder' ? <form onSubmit={submitRenameFolder}>
              <h2 id={modalTitleId}>Rename folder</h2>
              <p>Only you see your folders.</p>
              <DialogError message={dialogError} />
              <label><span>Folder name</span><SelectedInput maxLength={120} required {...field('title')} /></label>
              <div className="modal-actions"><button className="secondary-button" type="button" onClick={closeModal}>Cancel</button>
                <button className="primary-button" type="submit" disabled={busy || !draft.title.trim()}>Save name</button></div>
            </form> : null}


            {modal.kind === 'create' ? (
              <form onSubmit={submitCreate}>
                <div className="modal-icon create-icon"><UiIcon name="plus" /></div>
                <h2 id={modalTitleId}>Create a new board</h2>
                <p>{editableWorkbooks.length ? 'Give your canvas a name. You can move it to another workbook later.' : `Give your canvas a name. We’ll keep it in a workbook called “${FIRST_WORKBOOK_TITLE}”, which you can rename any time.`}</p>
                <DialogError message={dialogError} />
                <label>
                  <span>Board name</span>
                  <SelectedInput maxLength={120} {...field('title')} />
                </label>
                {editableWorkbooks.length ? <label>
                  <span>Workbook</span>
                  <select {...field('workbookId')}>
                    <option value="" disabled>Select a workbook</option>
                    {workbookOptions(editableWorkbooks)}
                  </select>
                </label> : null}
                {editableWorkbooks.length ? <label className="privacy-toggle"><input type="checkbox" checked={draft.private} onChange={event => setDraft(current => ({ ...current, private: event.target.checked }))} /><span>Private board — don’t inherit workbook sharing</span></label> : null}
                <div className="modal-actions">
                  <button className="secondary-button" type="button" onClick={closeModal}>Cancel</button>
                  <button className="primary-button" type="submit" disabled={busy || (editableWorkbooks.length > 0 && !draft.workbookId)}>Create board</button>
                </div>
              </form>
            ) : null}

            {modal.kind === 'rename' ? (
              <form onSubmit={submitRename}>
                <h2 id={modalTitleId}>Rename board</h2>
                <p>Choose a clear name so this board is easy to find later.</p>
                <DialogError message={dialogError} />
                <label>
                  <span>Board name</span>
                  <SelectedInput maxLength={120} {...field('title')} />
                </label>
                <div className="modal-actions">
                  <button className="secondary-button" type="button" onClick={closeModal}>Cancel</button>
                  <button className="primary-button" type="submit" disabled={busy || !draft.title.trim()}>Save name</button>
                </div>
              </form>
            ) : null}

            {modal.kind === 'move' || modal.kind === 'restore' ? (
              <MovePicker
                titleId={modalTitleId}
                mode={modal.kind}
                board={modal.board}
                folders={catalog.folders}
                workbooks={editableWorkbooks}
                busy={busy}
                error={<DialogError message={dialogError} />}
                filter={draft.filter}
                onFilter={filter => setDraft(current => ({ ...current, filter }))}
                selected={draft.workbookId}
                onSelect={workbookId => setDraft(current => ({ ...current, workbookId }))}
                onMove={workbookId => {
                  if (modal.kind === 'restore') void restoreBoard(modal.board, workbookId);
                  else void moveBoard(modal.board, workbookId);
                }}
                onCancel={closeModal}
              />
            ) : null}

          </section>
        </div>
      ) : null}
    </div>
  );
}

function DialogError({ message }: { message: string }) {
  return message ? <p className="dialog-error" role="alert">{message}</p> : null;
}
