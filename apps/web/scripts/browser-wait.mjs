import { setTimeout } from 'node:timers/promises';

/** Playwright's waitForFunction treats a returned Promise as truthy. Poll
 * asynchronous predicates here so a resolved false actually keeps waiting. */
export async function waitForAsync(predicate, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  do {
    if (await predicate()) return;
    await setTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(message);
}
