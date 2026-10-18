import { useSyncExternalStore } from 'react';
import { remainingTimerSeconds } from './board-timer';
import type { WorkshopTimer } from './room-collaboration';

/**
 * One clock for every countdown on the page. The floating timer and the
 * Workshop panel read the same tick, so they can never disagree by a second.
 */
const listeners = new Set<() => void>();
let now = Date.now();
let interval: number | undefined;

function tick() {
  now = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (interval === undefined) {
    now = Date.now();
    // A short tick keeps the displayed second close to the server deadline;
    // components re-render only when their whole-second value changes.
    interval = window.setInterval(tick, 250);
    document.addEventListener('visibilitychange', tick);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && interval !== undefined) {
      window.clearInterval(interval);
      interval = undefined;
      document.removeEventListener('visibilitychange', tick);
    }
  };
}

const idle = () => () => undefined;

/** Whole seconds left on a workshop timer, shared by every reader. */
export function useCountdown(timer: WorkshopTimer | null | undefined) {
  const live = timer?.status === 'running';
  return useSyncExternalStore(live ? subscribe : idle, () => remainingTimerSeconds(timer, live && interval !== undefined ? now : Date.now()));
}
