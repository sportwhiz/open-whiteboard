import { afterEach, expect, it, vi } from 'vitest';
import { createPresenceThrottle } from './presence-throttle';
afterEach(() => vi.useRealTimers());
it('publishes the final camera state when rapid navigation stops', () => {
  vi.useFakeTimers();
  let zoom = 1;
  const sent: number[] = [];
  const throttle = createPresenceThrottle(() => sent.push(zoom));
  throttle.schedule();
  zoom = 1.1; throttle.schedule();
  vi.advanceTimersByTime(30);
  zoom = 1.2; throttle.schedule();
  expect(sent).toEqual([1]);
  vi.advanceTimersByTime(36);
  expect(sent).toEqual([1, 1.2]);
  vi.advanceTimersByTime(1000);
  expect(sent).toHaveLength(2);
});
it('sends an immediate selection change without a redundant pending send', () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  const throttle = createPresenceThrottle(publish);
  throttle.schedule(); throttle.schedule(); throttle.schedule(true);
  vi.advanceTimersByTime(1000);
  expect(publish).toHaveBeenCalledTimes(2);
});
it('cancels pending publication when leaving a board', () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  const throttle = createPresenceThrottle(publish);
  throttle.schedule(); throttle.schedule(); throttle.cancel();
  vi.advanceTimersByTime(1000);
  expect(publish).toHaveBeenCalledTimes(1);
});
