import { describe, expect, it } from 'vitest';
import { searchBoards } from './search.server';

const board = (title: string, day: number, favorite = false) => ({ id: title, title, favorite, updatedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z` });

describe('board search', () => {
  it('ranks every title match before cutting, so an old exact match is kept', async () => {
    const boards = [
      ...Array.from({ length: 40 }, (_, index) => board(`Weekly retro notes ${index}`, 28)),
      board('Retro', 1),
    ];
    const { matches, complete } = await searchBoards(boards, 'retro');
    expect(matches).toHaveLength(30);
    expect(matches[0]).toMatchObject({ board: { title: 'Retro' }, match: 'title' });
    expect(complete).toBe(false);
  });

  it('reads content a few at a time, newest first, and stops once there are enough matches', async () => {
    const boards = Array.from({ length: 50 }, (_, index) => board(`Board ${index}`, 1 + (index % 28)));
    let inFlight = 0;
    let most = 0;
    const read: string[] = [];
    const result = await searchBoards(boards, 'needle', {
      limit: 3,
      readText: async item => {
        inFlight++; most = Math.max(most, inFlight); read.push(item.title);
        await new Promise(resolve => setTimeout(resolve, 1));
        inFlight--;
        return ['nothing here', 'a needle in text'];
      },
    });
    expect(most).toBeLessThanOrEqual(2);
    expect(result.matches).toHaveLength(3);
    expect(result.matches.every(match => match.match === 'content' && match.excerpt === 'a needle in text')).toBe(true);
    expect(read.length).toBeLessThanOrEqual(4);
    expect(boards.find(item => item.title === read[0])!.updatedAt >= boards.find(item => item.title === read.at(-1))!.updatedAt).toBe(true);
    expect(result.complete).toBe(false);
  });

  it('respects the read budget, skips unreadable boards and says when it was complete', async () => {
    const boards = Array.from({ length: 10 }, (_, index) => board(`Board ${index}`, index + 1));
    let reads = 0;
    const budgeted = await searchBoards(boards, 'note', { budget: 4, readText: async () => { reads++; throw new Error('room busy'); } });
    expect(reads).toBe(4);
    expect(budgeted).toMatchObject({ matches: [], complete: false });
    const full = await searchBoards(boards.slice(0, 3), 'note', { readText: async item => item.title === 'Board 1' ? ['A note'] : [] });
    expect(full.matches.map(match => [match.board.title, match.match])).toEqual([['Board 1', 'content']]);
    expect(full.complete).toBe(true);
  });

  it('stops reading when the request is aborted', async () => {
    const boards = Array.from({ length: 20 }, (_, index) => board(`Board ${index}`, index + 1));
    const controller = new AbortController();
    let reads = 0;
    const result = await searchBoards(boards, 'x', {
      signal: controller.signal,
      readText: async () => { if (++reads === 3) controller.abort(); return ['x marks the spot']; },
    });
    expect(reads).toBeLessThanOrEqual(4);
    expect(result.complete).toBe(false);
  });

  it('never reads content for boards whose titles already match', async () => {
    const seen: string[] = [];
    await searchBoards([board('Plan', 2), board('Other', 1)], 'plan', { readText: async item => { seen.push(item.title); return []; } });
    expect(seen).toEqual(['Other']);
  });
});

