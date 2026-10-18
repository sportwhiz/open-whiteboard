import { describe, expect, it } from 'vitest';
import {
  firstWorkbookGate,
  highlightParts,
  relativeTime,
  rovingTarget,
  sharedWithMe,
  matchRank,
  parseStudioRoute,
  readStudioPrefs,
  sectionBoards,
  sortBoards,
  studioHref,
  workbookTree,
  writeStudioPrefs,
} from './studio-view';

describe('Studio URLs', () => {
  it('round-trips every view, search and scope through a shareable address', () => {
    const cases = [
      ['/', { view: { kind: 'all' }, query: '', scope: 'view' }],
      ['/?view=favorites', { view: { kind: 'favorites' }, query: '', scope: 'view' }],
      ['/?view=shared', { view: { kind: 'shared' }, query: '', scope: 'view' }],
      ['/?workbook=workbook%3Aabc', { view: { kind: 'workbook', id: 'workbook:abc' }, query: '', scope: 'view' }],
      ['/?q=retro', { view: { kind: 'all' }, query: 'retro', scope: 'view' }],
      ['/?workbook=w1&q=retro', { view: { kind: 'workbook', id: 'w1' }, query: 'retro', scope: 'view' }],
      ['/?workbook=w1&q=retro&scope=all', { view: { kind: 'workbook', id: 'w1' }, query: 'retro', scope: 'all' }],
      ['/?view=favorites&q=a+b', { view: { kind: 'favorites' }, query: 'a b', scope: 'view' }],
    ] as const;
    for (const [href, route] of cases) {
      expect(parseStudioRoute(href.slice(1))).toEqual(route);
      expect(studioHref(route)).toBe(href);
    }
  });

  it('ignores unknown views, blank searches and scope outside workbooks', () => {
    expect(parseStudioRoute('?view=archive')).toEqual({ view: { kind: 'all' }, query: '', scope: 'view' });
    expect(parseStudioRoute('?q=%20%20')).toMatchObject({ query: '' });
    expect(parseStudioRoute('?q=x&scope=all')).toMatchObject({ scope: 'view' });
    expect(parseStudioRoute('?workbook=&view=shared')).toMatchObject({ view: { kind: 'shared' } });
    expect(parseStudioRoute(`?q=${'x'.repeat(300)}`).query).toHaveLength(120);
    expect(studioHref({ view: { kind: 'workbook', id: 'w' }, query: '', scope: 'all' })).toBe('/?workbook=w');
  });
});

const board = (title: string, updatedAt: string, favorite = false) => ({ title, updatedAt, favorite });

describe('board order', () => {
  const boards = [
    board('Weekly sync', '2026-10-03'),
    board('Retro', '2026-10-01', true),
    board('Sprint retro', '2026-10-05'),
    board('Board 10', '2026-10-02'),
    board('board 9', '2026-10-04', true),
  ];

  it('keeps favorites first under recency and sections them', () => {
    expect(sortBoards(boards, 'recent').map(item => item.title)).toEqual(['board 9', 'Retro', 'Sprint retro', 'Weekly sync', 'Board 10']);
    const sections = sectionBoards(boards, 'recent');
    expect(sections.map(section => [section.title, section.boards.length])).toEqual([['Favorites', 2], ['Recently edited', 3]]);
    expect(sectionBoards(boards.filter(item => item.favorite), 'recent')).toHaveLength(1);
    expect(sectionBoards(boards, 'recent', '', false)).toHaveLength(1);
  });

  it('sorts names naturally and case-insensitively', () => {
    expect(sortBoards(boards, 'name').map(item => item.title)).toEqual(['board 9', 'Board 10', 'Retro', 'Sprint retro', 'Weekly sync']);
    expect(sectionBoards(boards, 'name')).toEqual([{ key: 'all', title: null, boards: sortBoards(boards, 'name') }]);
  });

  it('ranks search results by how well the title matches', () => {
    const results = [
      board('Notes from the offsite', '2026-10-09'),
      board('Sprint retro', '2026-10-01'),
      board('Retro', '2026-10-02'),
      board('Retrospective plan', '2026-10-03'),
      board('Coretro map', '2026-10-08'),
    ];
    expect(sortBoards(results, 'relevance', 'retro').map(item => item.title)).toEqual(['Retro', 'Retrospective plan', 'Sprint retro', 'Coretro map', 'Notes from the offsite']);
    expect(matchRank(board('Retro', ''), '  RETRO ')).toBe(0);
    expect(matchRank(board('Anything', ''), '')).toBe(5);
  });
});

describe('workbook tree', () => {
  const folders = [{ id: 'f1', title: 'Product' }, { id: 'f2', title: 'Research' }, { id: 'f3', title: 'Empty' }];
  const workbooks = [
    { id: 'w1', folderId: 'f1', title: 'Roadmap' },
    { id: 'w2', folderId: 'f1', title: 'Launch' },
    { id: 'w3', folderId: 'f2', title: 'Interviews' },
    { id: 'w4', folderId: null, title: 'Scratch' },
    { id: 'w5', folderId: 'gone', title: 'Orphan' },
  ];

  it('lists every folder and the unfiled workbooks when not filtering', () => {
    const tree = workbookTree(folders, workbooks, '');
    expect(tree.filtering).toBe(false);
    expect(tree.folders.map(group => [group.folder.id, group.workbooks.length, group.total])).toEqual([['f1', 2, 2], ['f2', 1, 1], ['f3', 0, 0]]);
    expect(tree.unfiled.map(item => item.id)).toEqual(['w4', 'w5']);
  });

  it('shows only matching groups, omits an empty Unfiled group and keeps whole folders that match by name', () => {
    const byWorkbook = workbookTree(folders, workbooks, 'road');
    expect(byWorkbook.folders.map(group => [group.folder.id, group.workbooks.map(item => item.id)])).toEqual([['f1', ['w1']]]);
    expect(byWorkbook.unfiled).toEqual([]);
    const byFolder = workbookTree(folders, workbooks, 'research');
    expect(byFolder.folders.map(group => [group.folder.id, group.workbooks.map(item => item.id)])).toEqual([['f2', ['w3']]]);
    expect(workbookTree(folders, workbooks, 'zzz').empty).toBe(true);
  });
});

describe('Studio preferences', () => {
  it('reads defensively and writes what it reads', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    expect(readStudioPrefs(storage)).toEqual({ collapsed: [], sort: 'recent', layout: 'grid' });
    writeStudioPrefs(storage, { collapsed: ['f1'], sort: 'name', layout: 'grid' });
    expect(readStudioPrefs(storage)).toEqual({ collapsed: ['f1'], sort: 'name', layout: 'grid' });
    store.set('whiteboard:studio:v1', '{"collapsed":[1,"f2"],"sort":"weird"}');
    expect(readStudioPrefs(storage)).toEqual({ collapsed: ['f2'], sort: 'recent', layout: 'grid' });
    store.set('whiteboard:studio:v1', 'not json');
    expect(readStudioPrefs(storage)).toEqual({ collapsed: [], sort: 'recent', layout: 'grid' });
    expect(readStudioPrefs(undefined)).toEqual({ collapsed: [], sort: 'recent', layout: 'grid' });
    expect(() => writeStudioPrefs({ setItem: () => { throw new Error('quota'); } }, { collapsed: [], sort: 'recent', layout: 'grid' })).not.toThrow();
  });
});

describe('first workbook', () => {
  it('is created once across retries and concurrent requests, and retried after a failure', async () => {
    let calls = 0;
    let fail = true;
    const ensure = firstWorkbookGate(async () => { calls++; if (fail) throw new Error('offline'); return `workbook:${calls}`; });
    await expect(ensure('')).rejects.toThrow('offline');
    fail = false;
    const [first, second] = await Promise.all([ensure(''), ensure('')]);
    expect([first, second, await ensure('')]).toEqual(['workbook:2', 'workbook:2', 'workbook:2']);
    expect(await ensure('workbook:chosen')).toBe('workbook:chosen');
    expect(calls).toBe(2);
  });
});

describe('Studio details', () => {
  it('parses the trash view and keeps search out of it', () => {
    expect(parseStudioRoute('?view=trash&q=x')).toEqual({ view: { kind: 'trash' }, query: '', scope: 'view' });
    expect(studioHref({ view: { kind: 'trash' }, query: '', scope: 'view' })).toBe('/?view=trash');
  });

  it('remembers the board layout', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    expect(readStudioPrefs(storage).layout).toBe('grid');
    writeStudioPrefs(storage, { collapsed: [], sort: 'recent', layout: 'list' });
    expect(readStudioPrefs(storage).layout).toBe('list');
  });

  it('formats relative times consistently', () => {
    const now = new Date(2026, 9, 18, 15, 0).getTime();
    const at = (date: Date) => relativeTime(date.toISOString(), now);
    expect(at(new Date(2026, 9, 18, 14, 59, 40))).toBe('just now');
    expect(at(new Date(2026, 9, 18, 14, 55))).toBe('5m ago');
    expect(at(new Date(2026, 9, 18, 12, 0))).toBe('3h ago');
    expect(at(new Date(2026, 9, 17, 9, 0))).toBe('Yesterday');
    expect(at(new Date(2026, 9, 14, 9, 0))).toBe('4d ago');
    expect(at(new Date(2026, 8, 30, 9, 0))).toMatch(/30/u);
    expect(at(new Date(2025, 8, 30, 9, 0))).toMatch(/2025/u);
    expect(relativeTime('not a date', now)).toBe('');
  });

  it('splits text around every match without changing it', () => {
    expect(highlightParts('Sprint retro – Retro notes', 'retro')).toEqual([
      { text: 'Sprint ', match: false }, { text: 'retro', match: true }, { text: ' – ', match: false },
      { text: 'Retro', match: true }, { text: ' notes', match: false },
    ]);
    expect(highlightParts('Plan', '')).toEqual([{ text: 'Plan', match: false }]);
    expect(highlightParts('<b>x</b>', 'b').map(part => part.text).join('')).toBe('<b>x</b>');
  });

  it('moves between cards by row and column', () => {
    // Two rows of three cards, then a section heading and one more card.
    const rects = [0, 1, 2].map(column => ({ left: column * 100, top: 0, width: 90, height: 90 }))
      .concat([0, 1].map(column => ({ left: column * 100, top: 100, width: 90, height: 90 })))
      .concat([{ left: 0, top: 260, width: 90, height: 90 }]);
    expect(rovingTarget(rects, 2, 'ArrowDown')).toBe(4);
    expect(rovingTarget(rects, 4, 'ArrowDown')).toBe(5);
    expect(rovingTarget(rects, 5, 'ArrowUp')).toBe(3);
    expect(rovingTarget(rects, 0, 'ArrowUp')).toBe(0);
    expect(rovingTarget(rects, 2, 'ArrowRight')).toBe(3);
    expect(rovingTarget(rects, 0, 'ArrowLeft')).toBe(0);
    expect(rovingTarget(rects, 3, 'End')).toBe(5);
    expect(rovingTarget(rects, 3, 'Home')).toBe(0);
  });

  it('counts boards reached through other people as shared', () => {
    const roles = new Map([['mine', 'owner'], ['theirs', 'editor']]);
    expect(sharedWithMe({ workbookId: 'mine', role: 'owner' }, roles)).toBe(false);
    expect(sharedWithMe({ workbookId: 'theirs', role: 'owner' }, roles)).toBe(true);
    expect(sharedWithMe({ workbookId: 'mine', role: 'viewer' }, roles)).toBe(true);
    expect(sharedWithMe({ workbookId: 'workbook:shared', role: 'owner' }, roles)).toBe(true);
  });
});

describe('counting words', () => {
  it('agrees with the count', async () => {
    const { plural, agree } = await import('./studio-view');
    expect(plural(1, 'matching board')).toBe('1 matching board');
    expect(plural(3, 'matching board')).toBe('3 matching boards');
    expect(plural(0, 'workbook')).toBe('0 workbooks');
    expect(plural(2, 'person', 'people')).toBe('2 people');
    expect(`${plural(1, 'workbook')} ${agree(1, 'moves', 'move')}`).toBe('1 workbook moves');
    expect(`${plural(2, 'workbook')} ${agree(2, 'moves', 'move')}`).toBe('2 workbooks move');
  });
});
