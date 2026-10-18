/**
 * Pure Studio state: the URL that names a view, how boards are ordered, how
 * the workbook tree is filtered, and the small preferences kept per browser.
 * Kept free of React so it can be unit tested.
 */

import { byRecent, compareRelevance, matchRank } from './search-rank';

export type StudioView =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'shared' }
  | { kind: 'trash' }
  | { kind: 'workbook'; id: string };

/**
 * `query` is the committed search ('' when browsing). Inside a workbook a
 * search is scoped to it unless `scope` is 'all'.
 */
export type StudioRoute = { view: StudioView; query: string; scope: 'view' | 'all' };

export const MAX_QUERY_LENGTH = 120;

export function parseStudioRoute(search: string): StudioRoute {
  const params = new URLSearchParams(search);
  const workbook = params.get('workbook')?.trim();
  const named = params.get('view');
  const view: StudioView = workbook
    ? { kind: 'workbook', id: workbook }
    : named === 'favorites' || named === 'shared' || named === 'trash'
      ? { kind: named }
      : { kind: 'all' };
  // Trash is a list to restore from, not a place to search.
  const query = view.kind === 'trash' ? '' : (params.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  const scope = view.kind === 'workbook' && params.get('scope') === 'all' ? 'all' : 'view';
  return { view, query, scope };
}

/** The canonical, shareable address of a view. Only "/" is used, so no server routes change. */
export function studioHref(route: StudioRoute) {
  const params = new URLSearchParams();
  if (route.view.kind === 'workbook') params.set('workbook', route.view.id);
  else if (route.view.kind !== 'all') params.set('view', route.view.kind);
  if (route.query) {
    params.set('q', route.query);
    if (route.view.kind === 'workbook' && route.scope === 'all') params.set('scope', 'all');
  }
  const search = params.toString();
  return search ? `/?${search}` : '/';
}

export function viewKey(view: StudioView) {
  return view.kind === 'workbook' ? `workbook:${view.id}` : view.kind;
}

export function browseRoute(view: StudioView): StudioRoute {
  return { view, query: '', scope: 'view' };
}

export type SortableBoard = {
  title: string;
  favorite: boolean;
  updatedAt: string;
  matchedText?: string;
};

export type BrowseSort = 'recent' | 'name';
export type SearchSort = 'relevance' | BrowseSort;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a: SortableBoard, b: SortableBoard) => collator.compare(a.title, b.title) || byRecent(a, b);

export { matchRank };

/** Order boards for display. Recency keeps favorites first, as the catalog always has. */
export function sortBoards<T extends SortableBoard>(boards: readonly T[], sort: SearchSort, query = ''): T[] {
  const sorted = [...boards];
  if (sort === 'name') return sorted.sort(byName);
  if (sort === 'relevance') {
    return sorted.sort(compareRelevance(query));
  }
  return sorted.sort((a, b) => Number(b.favorite) - Number(a.favorite) || byRecent(a, b));
}

export type BoardSection<T> = { key: 'favorites' | 'recent' | 'all'; title: string | null; boards: T[] };

/**
 * Under recency, favorites are pinned in their own labelled section so their
 * position is explained rather than surprising. A single list otherwise.
 */
export function sectionBoards<T extends SortableBoard>(boards: readonly T[], sort: SearchSort, query = '', pinFavorites = true): BoardSection<T>[] {
  const sorted = sortBoards(boards, sort, query);
  if (sort !== 'recent' || !pinFavorites) return [{ key: 'all', title: null, boards: sorted }];
  const favorites = sorted.filter(board => board.favorite);
  const others = sorted.filter(board => !board.favorite);
  if (!favorites.length || !others.length) return [{ key: 'all', title: null, boards: sorted }];
  return [
    { key: 'favorites', title: 'Favorites', boards: favorites },
    { key: 'recent', title: 'Recently edited', boards: others },
  ];
}

export type TreeFolder = { id: string; title: string };
export type TreeWorkbook = { id: string; folderId: string | null; title: string };
export type WorkbookTree<F, W> = {
  filtering: boolean;
  folders: Array<{ folder: F; workbooks: W[]; total: number }>;
  unfiled: W[];
  empty: boolean;
};

/**
 * Group workbooks by folder. While filtering, a folder whose name matches
 * shows all of its workbooks, otherwise only matching ones; folders and the
 * Unfiled group without matches are omitted.
 */
export function workbookTree<F extends TreeFolder, W extends TreeWorkbook>(folders: readonly F[], workbooks: readonly W[], filter: string): WorkbookTree<F, W> {
  const needle = filter.trim().toLocaleLowerCase();
  const matches = (title: string) => title.toLocaleLowerCase().includes(needle);
  const folderIds = new Set(folders.map(folder => folder.id));
  const groups = folders.map(folder => {
    const inside = workbooks.filter(workbook => workbook.folderId === folder.id);
    const shown = !needle || matches(folder.title) ? inside : inside.filter(workbook => matches(workbook.title));
    return { folder, workbooks: shown, total: inside.length };
  }).filter(group => !needle || group.workbooks.length > 0 || matches(group.folder.title));
  const unfiled = workbooks.filter(workbook => !workbook.folderId || !folderIds.has(workbook.folderId))
    .filter(workbook => !needle || matches(workbook.title));
  return {
    filtering: Boolean(needle),
    folders: groups,
    unfiled,
    empty: groups.length === 0 && unfiled.length === 0,
  };
}

export type BoardLayout = 'grid' | 'list';
export type StudioPrefs = { collapsed: string[]; sort: BrowseSort; layout: BoardLayout };
const PREFS_KEY = 'whiteboard:studio:v1';
const DEFAULT_PREFS: StudioPrefs = { collapsed: [], sort: 'recent', layout: 'grid' };

export function readStudioPrefs(storage: Pick<Storage, 'getItem'> | undefined): StudioPrefs {
  try {
    const value: unknown = JSON.parse(storage?.getItem(PREFS_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return DEFAULT_PREFS;
    const { collapsed, sort, layout } = value as Record<string, unknown>;
    return {
      collapsed: Array.isArray(collapsed) ? collapsed.filter((id): id is string => typeof id === 'string').slice(0, 500) : [],
      sort: sort === 'name' ? 'name' : 'recent',
      layout: layout === 'list' ? 'list' : 'grid',
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writeStudioPrefs(storage: Pick<Storage, 'setItem'> | undefined, prefs: StudioPrefs) {
  try { storage?.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* Private browsing or a full quota: keep working without persistence. */ }
}

/**
 * Create the first workbook at most once. If creating the board after it
 * fails, a retry reuses the same workbook instead of adding another
 * "My boards"; a failed workbook creation can be retried.
 */
export function firstWorkbookGate(create: () => Promise<string>) {
  let created: Promise<string> | null = null;
  return (existing: string) => {
    if (existing) return Promise.resolve(existing);
    created ??= create().catch(error => { created = null; throw error; });
    return created;
  };
}

const DAY = 86_400_000;

/**
 * A short, consistent relative time: "just now", "5m ago", "3h ago",
 * "Yesterday", "4d ago", then a date ("Oct 16", with the year when it differs).
 */
export function relativeTime(value: string, now = Date.now()) {
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return '';
  const elapsed = Math.max(0, now - time);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (time >= startOfToday - DAY) return 'Yesterday';
  const days = Math.floor(elapsed / DAY);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, date.getFullYear() === today.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Split text around case-insensitive matches of the query, for safe highlighting without HTML. */
export function highlightParts(text: string, query: string): Array<{ text: string; match: boolean }> {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [{ text, match: false }];
  const haystack = text.toLocaleLowerCase();
  // Lowercasing can change length for some scripts; only highlight when positions line up.
  if (haystack.length !== text.length) return [{ text, match: false }];
  const parts: Array<{ text: string; match: boolean }> = [];
  let from = 0;
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + needle.length)) {
    if (index > from) parts.push({ text: text.slice(from, index), match: false });
    parts.push({ text: text.slice(index, index + needle.length), match: true });
    from = index + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts.length ? parts : [{ text, match: false }];
}

export type Rect = { left: number; top: number; width: number; height: number };

/**
 * The item an arrow key should move to in a wrapped grid or a list, from the
 * items' on-screen boxes: left/right step through reading order, up/down go
 * to the nearest item in the previous or next row, Home/End to the ends.
 */
export function rovingTarget(rects: readonly Rect[], index: number, key: string) {
  const last = rects.length - 1;
  if (index < 0 || index > last) return Math.max(0, Math.min(last, index));
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  if (key === 'ArrowRight') return Math.min(last, index + 1);
  if (key === 'ArrowLeft') return Math.max(0, index - 1);
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return index;
  const current = rects[index];
  const middle = current.top + current.height / 2;
  const centre = current.left + current.width / 2;
  const candidates = rects
    .map((rect, position) => ({ rect, position }))
    .filter(({ rect }) => key === 'ArrowDown' ? rect.top >= middle : rect.top + rect.height <= middle);
  if (!candidates.length) return index;
  const rowTop = key === 'ArrowDown'
    ? Math.min(...candidates.map(({ rect }) => rect.top))
    : Math.max(...candidates.map(({ rect }) => rect.top));
  const row = candidates.filter(({ rect }) => Math.abs(rect.top - rowTop) < 4);
  row.sort((a, b) => Math.abs(a.rect.left + a.rect.width / 2 - centre) - Math.abs(b.rect.left + b.rect.width / 2 - centre));
  return row[0].position;
}

export type SharingBoard = { workbookId: string | null; role?: string };

/**
 * A board is "shared with me" when it reaches this person through someone
 * else: they do not own the board, or they do not own its workbook.
 */
export function sharedWithMe(board: SharingBoard, workbookRoles: ReadonlyMap<string, string | undefined>) {
  if (board.workbookId === 'workbook:shared' || board.role !== 'owner') return true;
  const workbookRole = board.workbookId ? workbookRoles.get(board.workbookId) : undefined;
  return Boolean(workbookRole && workbookRole !== 'owner');
}

/** "1 board", "3 boards"; pass the plural for irregular words. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** The verb form that agrees with a count: agree(1, 'moves', 'move') → "moves". */
export function agree(count: number, singular: string, pluralForm: string) {
  return count === 1 ? singular : pluralForm;
}
