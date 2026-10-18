/**
 * Search ranking shared by the Studio and the search API, so the server keeps
 * the same boards the Studio would show first. No DOM or runtime APIs.
 */
export type RankedBoard = { title: string; favorite: boolean; updatedAt: string };

/** Exact title, title prefix, a word in the title, anywhere in the title, then note text. Lower is better. */
export function matchRank(board: Pick<RankedBoard, 'title'>, query: string) {
  const title = board.title.toLocaleLowerCase();
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 5;
  if (title === needle) return 0;
  if (title.startsWith(needle)) return 1;
  if (title.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(needle))) return 2;
  if (title.includes(needle)) return 3;
  return 4;
}

export const byRecent = (a: Pick<RankedBoard, 'updatedAt'>, b: Pick<RankedBoard, 'updatedAt'>) => b.updatedAt.localeCompare(a.updatedAt);

/** Best match first; ties go to favorites, then the most recently edited. */
export function compareRelevance(query: string) {
  return (a: RankedBoard, b: RankedBoard) => matchRank(a, query) - matchRank(b, query) ||
    Number(b.favorite) - Number(a.favorite) || byRecent(a, b);
}

/** Boards whose title contains the query, best match first. Cheap: no board content is read. */
export function titleMatches<T extends RankedBoard>(boards: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return boards.filter(board => board.title.toLocaleLowerCase().includes(needle)).sort(compareRelevance(query));
}
