/** Refresh ephemeral writing presence while a nonempty draft is open. */
export function reportWriting(send: (writing: boolean) => Promise<unknown>, writing: boolean) {
  const report = () => void send(writing).catch(() => undefined);
  report();
  const timer = writing ? setInterval(report, 30_000) : undefined;
  return () => clearInterval(timer);
}
