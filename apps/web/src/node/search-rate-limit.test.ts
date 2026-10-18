import { describe, expect, it, vi } from 'vitest';

describe('search rate limit', () => {
  it('allows a steady pace of note searches per person and then answers 429', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const { SqliteCatalog } = await import('./sqlite-catalog');
    const { enforceRateLimit } = await import('../collaboration.server');
    const { SEARCH_RATE_LIMIT } = await import('../search.server');
    const directory = await mkdtemp(resolve(tmpdir(), 'whiteboard-search-'));
    const database = await SqliteCatalog.open(resolve(directory, 'catalog.sqlite'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T12:00:05Z'));
    try {
      await database.migrate(resolve('migrations'));
      const db = database as unknown as D1Database;
      for (let index = 0; index < SEARCH_RATE_LIMIT; index++) await enforceRateLimit(db, 'person:search', SEARCH_RATE_LIMIT, 60);
      await expect(enforceRateLimit(db, 'person:search', SEARCH_RATE_LIMIT, 60)).rejects.toMatchObject({ status: 429 });
      await expect(enforceRateLimit(db, 'someone-else:search', SEARCH_RATE_LIMIT, 60)).resolves.toBeUndefined();
      vi.setSystemTime(new Date('2026-10-18T12:01:05Z'));
      await expect(enforceRateLimit(db, 'person:search', SEARCH_RATE_LIMIT, 60)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
