import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ snapshot: undefined as undefined | { cacheNamespace?: string; user?: { id: string } } }));
vi.mock('./auth-client', () => ({ authSnapshot: () => auth.snapshot, subscribeAuth: () => () => undefined }));

import { clearBoardDrafts, readBoardDraft, writeBoardDraft } from './collaboration-drafts';

describe('unsent drafts are private to one account', () => {
  beforeEach(() => { clearBoardDrafts(); auth.snapshot = { cacheNamespace: 'studio', user: { id: 'ana' } }; });

  it('never shows one account’s drafts to the next account in the same tab', () => {
    writeBoardDraft('board-1', 'comment', 'Ana’s private thought');
    expect(readBoardDraft('board-1', 'comment', '')).toBe('Ana’s private thought');
    auth.snapshot = { cacheNamespace: 'studio', user: { id: 'bo' } };
    expect(readBoardDraft('board-1', 'comment', '')).toBe('');
    // And they are gone, not just hidden, if Ana signs back in.
    auth.snapshot = { cacheNamespace: 'studio', user: { id: 'ana' } };
    expect(readBoardDraft('board-1', 'comment', '')).toBe('');
  });

  it('keeps drafts while the session is only being re-checked', () => {
    writeBoardDraft('board-1', 'comment', 'Still mine');
    auth.snapshot = undefined;
    expect(readBoardDraft('board-1', 'comment', '')).toBe('Still mine');
    auth.snapshot = { cacheNamespace: 'studio', user: { id: 'ana' } };
    expect(readBoardDraft('board-1', 'comment', '')).toBe('Still mine');
  });

  it('forgets drafts when the session signs out', () => {
    writeBoardDraft('board-1', 'brainstorm-draft', 'Idea');
    auth.snapshot = { cacheNamespace: 'studio' };
    expect(readBoardDraft('board-1', 'brainstorm-draft', '')).toBe('');
  });
});
