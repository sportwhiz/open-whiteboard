import { titleMatches, type RankedBoard } from './search-rank';

export type SearchMatch<T> = { board: T; match: 'title' | 'content'; excerpt: string };

export type SearchOptions<T> = {
  /** Read the text of one board. Only called for boards whose title does not match. */
  readText?: (board: T) => Promise<readonly string[]>;
  /** Most matches to return. */
  limit?: number;
  /** Most boards whose content may be read for one request. */
  budget?: number;
  /** Reads in flight at once. Kept low so search never crowds out live editing. */
  concurrency?: number;
  /** Stop reading once the client has gone or moved on to another query. */
  signal?: AbortSignal;
};

export const SEARCH_LIMIT = 30;
export const SEARCH_CONTENT_BUDGET = 100;
export const SEARCH_CONCURRENCY = 2;
/** Note searches per person per minute; the Studio sends one only after a pause in typing. */
export const SEARCH_RATE_LIMIT = 40;

/**
 * Title matches are ranked across every visible board before the result is
 * cut, so an exact title is never dropped for recency. Note content is read
 * only for the most recent boards within a budget, a few at a time, and the
 * scan stops as soon as there are enough matches or the request is aborted.
 * `complete` is false when some boards were not searched (budget, early
 * stop or abort), so the Studio can say so.
 */
export async function searchBoards<T extends RankedBoard>(boards: readonly T[], query: string, options: SearchOptions<T> = {}) {
  const limit = options.limit ?? SEARCH_LIMIT;
  const needle = query.trim().toLocaleLowerCase();
  const titled = titleMatches(boards, query);
  const matches: SearchMatch<T>[] = titled.slice(0, limit).map(board => ({ board, match: 'title', excerpt: board.title }));
  if (!options.readText || !needle) return { matches, complete: titled.length <= limit, read: 0 };
  const titledSet = new Set<T>(titled);
  // Most recently edited first: the boards people are most likely looking for.
  const rest = boards.filter(board => !titledSet.has(board)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const budget = Math.min(rest.length, options.budget ?? SEARCH_CONTENT_BUDGET);
  const found: Array<{ index: number; match: SearchMatch<T> }> = [];
  let next = 0;
  let read = 0;
  const enough = () => matches.length + found.length >= limit;
  const worker = async () => {
    while (next < budget && !enough() && !options.signal?.aborted) {
      const index = next++;
      const board = rest[index];
      read++;
      try {
        const text = (await options.readText!(board)).find(value => value.toLocaleLowerCase().includes(needle));
        if (text !== undefined && !options.signal?.aborted) found.push({ index, match: { board, match: 'content', excerpt: text } });
      } catch {
        // An unreadable board is skipped rather than failing the whole search.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? SEARCH_CONCURRENCY, budget || 1)) }, worker));
  // Keep content matches in recency order regardless of which read finished first.
  found.sort((a, b) => a.index - b.index);
  matches.push(...found.slice(0, Math.max(0, limit - matches.length)).map(item => item.match));
  // Complete only when every visible board was considered.
  const complete = titled.length <= limit && !options.signal?.aborted && next >= rest.length;
  return { matches, complete, read };
}

