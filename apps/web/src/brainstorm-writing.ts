// Keep close/reopen signals in order, even across component remounts.
const pending = new Map<string, Promise<void>>();

/** Refresh ephemeral writing presence while a nonempty draft is open. */
export function reportWriting(send: (writing: boolean) => Promise<unknown>, writing: boolean, scope: string) {
  const report = (value: boolean) => {
    const task = (pending.get(scope) ?? Promise.resolve())
      .then(() => send(value)).then(() => undefined, () => undefined);
    pending.set(scope, task);
    void task.then(() => { if (pending.get(scope) === task) pending.delete(scope); });
  };
  report(writing);
  const timer = writing ? setInterval(() => report(true), 30_000) : undefined;
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (writing) report(false);
  };
}
