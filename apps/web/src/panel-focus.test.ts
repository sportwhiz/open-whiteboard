import { afterEach, describe, expect, it } from 'vitest';
import { shouldRescueFocus, visibleCanvasCentre } from './panel-focus';
import { holdsUnsentText, threadLink } from './collaboration-drafts';

describe('panel focus rescue', () => {
  const base = { lostConnected: true, lostDisabled: false, activeIsBody: true, activeIsLost: false };
  it('moves focus when the control in use was removed or disabled', () => {
    expect(shouldRescueFocus({ ...base, lostConnected: false })).toBe(true);
    expect(shouldRescueFocus({ ...base, lostDisabled: true })).toBe(true);
    expect(shouldRescueFocus({ ...base, lostDisabled: true, activeIsBody: false, activeIsLost: true })).toBe(true);
  });
  it('never pulls focus back after someone left on purpose', () => {
    // e.g. typed a comment, then clicked a canvas toolbar button (Safari leaves focus on the body)
    expect(shouldRescueFocus(base)).toBe(false);
    // focus is somewhere else entirely
    expect(shouldRescueFocus({ ...base, lostConnected: false, activeIsBody: false })).toBe(false);
  });
});

describe('unsent text', () => {
  it('protects written drafts but not prefilled settings', () => {
    expect(holdsUnsentText({ dataset: { draft: '' }, value: 'Half a thought' } as unknown as EventTarget)).toBe(true);
    expect(holdsUnsentText({ dataset: { draft: '' }, value: '   ' } as unknown as EventTarget)).toBe(false);
    // Timer minutes, brainstorm title and vote numbers are not drafts.
    expect(holdsUnsentText({ dataset: {}, value: 'Silent brainstorm' } as unknown as EventTarget)).toBe(false);
    expect(holdsUnsentText({ dataset: {}, value: '5' } as unknown as EventTarget)).toBe(false);
    expect(holdsUnsentText(null)).toBe(false);
  });
});

describe('thread links', () => {
  it('never include a guest token or other fragment', () => {
    expect(threadLink('https://studio.example/boards/b1#link=secret-token', 'thread:1')).toBe('https://studio.example/boards/b1?thread=thread%3A1');
    expect(threadLink('https://studio.example/boards/b1?thread=old', 'thread:2')).toBe('https://studio.example/boards/b1?thread=thread%3A2');
  });
});

describe('visible canvas centre', () => {
  const original = globalThis.window;
  afterEach(() => { globalThis.window = original; });
  it('asks the canvas synchronously and falls back to presence', () => {
    const target = new EventTarget();
    globalThis.window = target as unknown as Window & typeof globalThis;
    expect(visibleCanvasCentre({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    target.addEventListener('whiteboard-viewport-query', event => { (event as CustomEvent<{ viewport?: object }>).detail.viewport = { x: 300, y: 120, zoom: 1 }; });
    expect(visibleCanvasCentre({ x: 1, y: 2 })).toEqual({ x: 300, y: 120, zoom: 1 });
  });
});

describe('canvas selection for voting', () => {
  const original = globalThis.window;
  afterEach(() => { globalThis.window = original; });
  it('reads the selection the canvas reports, and nothing when it does not answer', async () => {
    const { queryCanvas } = await import('./panel-focus');
    const target = new EventTarget();
    globalThis.window = target as unknown as Window & typeof globalThis;
    expect(queryCanvas().selection).toBeUndefined();
    target.addEventListener('whiteboard-viewport-query', event => { Object.assign((event as CustomEvent<Record<string, unknown>>).detail, { selection: ['note:1', 7, 'note:2'] }); });
    expect(queryCanvas().selection).toEqual(['note:1', 'note:2']);
  });
});
