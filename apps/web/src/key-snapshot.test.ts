import { afterEach, describe, expect, it } from 'vitest';
import { keySnapshot, stampKeyEvent } from './key-snapshot';

describe('key snapshots', () => {
  const original = globalThis.window;
  afterEach(() => { globalThis.window = original; });
  it('remember the selection from before any handler cleared it', () => {
    let selection = ['note:1'];
    const target = new EventTarget();
    target.addEventListener('whiteboard-viewport-query', event => { (event as CustomEvent<{ selection?: string[] }>).detail.selection = [...selection]; });
    globalThis.window = target as unknown as Window & typeof globalThis;
    const escape = { key: 'Escape' } as KeyboardEvent;
    stampKeyEvent(escape);
    // The canvas clears the selection while handling the same Escape.
    selection = [];
    expect(keySnapshot(escape)).toEqual({ hadSelection: true });
    const next = { key: 'Escape' } as KeyboardEvent;
    stampKeyEvent(next);
    expect(keySnapshot(next)).toEqual({ hadSelection: false });
    expect(keySnapshot({ key: 'a' } as unknown as Event)).toBeUndefined();
  });
});
