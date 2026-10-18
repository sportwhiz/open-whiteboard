import { useCallback, useState } from 'react';
import { authSnapshot, subscribeAuth } from './auth-client';

// Forget drafts as soon as a different account is signed in.
subscribeAuth(() => { queueMicrotask(draftOwner); });

/**
 * Unsent comment, reply and brainstorm text for this tab. The side panel
 * unmounts when it closes; drafts must not disappear with it. Memory only:
 * nothing is written to storage on shared devices.
 */
const drafts = new Map<string, unknown>();
let owner: string | undefined;

/**
 * Drafts belong to one signed-in person. If the app is reused by another
 * account without a reload (an expired session signed in again as someone
 * else), everything from the previous account is forgotten first.
 */
function draftOwner() {
  const snapshot = authSnapshot();
  // While the session is being re-checked there is no snapshot; keep the
  // current owner rather than treating it as a change.
  const current = snapshot ? `${snapshot.cacheNamespace ?? ''}\u0000${snapshot.user?.id ?? 'signed-out'}` : owner ?? 'unknown';
  if (owner !== undefined && owner !== current && snapshot) drafts.clear();
  if (snapshot || owner === undefined) owner = current;
  return owner;
}
const draftId = (boardId: string, key: string) => `${draftOwner()}\u0000${boardId}\u0000${key}`;

export function readBoardDraft<T>(boardId: string, key: string, fallback: T): T {
  const id = draftId(boardId, key);
  return drafts.has(id) ? drafts.get(id) as T : fallback;
}

export function useBoardDraft<T>(boardId: string, key: string, initial: T) {
  const [value, setValue] = useState<T>(() => readBoardDraft(boardId, key, initial));
  const update = useCallback((next: T | ((current: T) => T)) => {
    setValue(current => {
      const resolved = typeof next === 'function' ? (next as (current: T) => T)(current) : next;
      drafts.set(draftId(boardId, key), resolved);
      return resolved;
    });
  }, [boardId, key]);
  return [value, update] as const;
}

/** Store a draft directly (tests and non-React callers). */
export function writeBoardDraft(boardId: string, key: string, value: unknown) {
  drafts.set(draftId(boardId, key), value);
}

/** Forget every unsent draft, for example when signing out on a shared device. */
export function clearBoardDrafts() {
  drafts.clear();
}

type DraftField = { dataset?: { draft?: string }; value?: unknown; isContentEditable?: boolean; textContent?: string | null };

/**
 * Whether a field holds writing that a stray Escape must not throw away.
 * Only free-text fields marked `data-draft` count (comments, replies, ideas,
 * checkpoint names); settings fields with a prefilled value, such as timer
 * minutes or a brainstorm title, do not.
 */
export function holdsUnsentText(target: EventTarget | null) {
  const field = target as DraftField | null;
  if (!field || field.dataset?.draft === undefined) return false;
  const text = field.isContentEditable ? field.textContent : field.value;
  return typeof text === 'string' && text.trim().length > 0;
}

/** A shareable link to a comment thread: never carries a guest token or other fragment. */
export function threadLink(href: string, threadId: string) {
  const url = new URL(href);
  url.hash = '';
  url.searchParams.set('thread', threadId);
  return url.href;
}
