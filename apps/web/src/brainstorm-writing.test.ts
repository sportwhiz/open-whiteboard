import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportWriting } from './brainstorm-writing';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('writing presence cleanup', () => {
  it('clears writing on close and stops heartbeats, including repeated cleanup', async () => {
    const send = vi.fn(async (_writing: boolean) => undefined);
    const close = reportWriting(send, true, 'close');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send.mock.calls.map(([value]) => value)).toEqual([true, true]);
    close();
    close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send.mock.calls.map(([value]) => value)).toEqual([true, true, false]);
  });

  it('orders close and reopen behind an in-flight heartbeat', async () => {
    let finish!: () => void;
    const first = new Promise<void>(resolve => { finish = resolve; });
    const send = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined);
    const close = reportWriting(send, true, 'reopen');
    await vi.advanceTimersByTimeAsync(0);
    close();
    const closeAgain = reportWriting(send, true, 'reopen');
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls).toEqual([[true]]);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls).toEqual([[true], [false], [true]]);
    closeAgain();
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it('still sends cleanup after a failed heartbeat', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValue(undefined);
    const close = reportWriting(send, true, 'failure');
    close();
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls).toEqual([[true], [false]]);
  });

  it('does not refresh an empty draft or send redundant cleanup', async () => {
    const send = vi.fn(async (_writing: boolean) => undefined);
    const close = reportWriting(send, false, 'empty');
    await vi.advanceTimersByTimeAsync(60_000);
    close();
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls).toEqual([[false]]);
  });
});
