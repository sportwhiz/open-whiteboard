/** Publish at a bounded rate, including the latest state after input stops. */
export function createPresenceThrottle(publish: () => void, interval = 66) {
  let lastSent = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  const schedule = (force = false) => {
    const remaining = interval - (Date.now() - lastSent);
    if (!force && remaining > 0) {
      timer ??= setTimeout(() => { timer = undefined; schedule(); }, remaining);
      return;
    }
    cancel();
    lastSent = Date.now();
    publish();
  };
  return { schedule, cancel };
}
