/** Pure state for settings forms, shared by FormSaveBar and its tests. */
export type SaveBarTone = 'idle' | 'dirty' | 'busy' | 'saved' | 'error' | 'discarded';

/**
 * What the save bar says. The latest event wins: saving, then a failed save
 * (which keeps the unsaved edits), then unsaved edits (a previous "saved"
 * notice is stale once the form changes), then the last save's success.
 */
export function saveBarMessage({ dirty, busy, error = '', notice = '', discarded = false }: { dirty: boolean; busy: boolean; error?: string; notice?: string; discarded?: boolean }): { tone: SaveBarTone; text: string } {
  if (busy) return { tone: 'busy', text: 'Saving…' };
  if (error) return { tone: 'error', text: dirty ? `${sentence(error)} Your changes have not been saved.` : error };
  if (dirty) return { tone: 'dirty', text: 'You have unsaved changes' };
  if (notice) return { tone: 'saved', text: notice };
  if (discarded) return { tone: 'discarded', text: 'Changes discarded' };
  return { tone: 'idle', text: 'No unsaved changes' };
}

/** Whether leaving through this link would throw away a dirty form. */
export function shouldGuardLink(link: Pick<HTMLAnchorElement, 'href' | 'target' | 'hasAttribute'>, current: string) {
  if (link.hasAttribute('download') || (link.target && link.target !== '_self')) return false;
  let url: URL;
  let here: URL;
  try { url = new URL(link.href, current); here = new URL(current); } catch { return false; }
  if (url.origin !== here.origin) return false;
  // Jumping within the same page keeps the form.
  if (url.pathname === here.pathname && url.search === here.search) return false;
  return !url.pathname.startsWith('/api/');
}

const sentence = (value: string) => /[.!?…]$/u.test(value.trim()) ? value.trim() : `${value.trim()}.`;

/** The policy field a server error is about, so it can be marked and focused. */
export function policyFieldForError(error: string): string | null {
  const text = error.toLowerCase();
  if (text.includes('installation name')) return 'title';
  if (text.includes('registration')) return 'registration';
  if (text.includes('magic link')) return 'magic_link';
  if (text.includes('session limit')) return 'session_idle_seconds';
  if (text.includes('ask again') || text.includes('verification window') || text.includes('reauthentication')) return 'reauthentication_seconds';
  return null;
}

/** The first limit outside the range the server accepts. */
export function invalidLimit(form: Record<string, string | number>, keys: string[]): string | null {
  for (const key of keys) {
    const value = Number(form[key]);
    const max = key.includes('storage') ? 1_099_511_627_776 : 1_000_000;
    if (!Number.isSafeInteger(value) || value < (key === 'member_limit' ? 1 : 0) || value > max) return key;
  }
  return null;
}

export type BulkKind = 'approve' | 'secure' | 'suspend';

/** The selected people a bulk action applies to. */
export function bulkTargets(people: { id: string; status: string }[], kind: BulkKind) {
  return people.filter(person => person.status !== 'deleted' && (
    kind === 'approve' ? person.status === 'pending_approval'
      : kind === 'suspend' ? person.status !== 'suspended'
      : true
  )).map(person => person.id);
}

/** "Approved 20 of 30 people. 10 could not be approved: <reasons>." */
export function bulkFailureMessage(kind: BulkKind, done: number, total: number, errors: (string | undefined)[]) {
  const verb = { approve: ['Approved', 'approved'], secure: ['Secured', 'secured'], suspend: ['Suspended', 'suspended'] }[kind];
  const failed = total - done;
  const reasons = [...new Set(errors.filter((error): error is string => Boolean(error && error.trim())))];
  const why = reasons.length ? `: ${sentence(reasons.join('; '))}` : '. Try again.';
  return `${verb[0]} ${done} of ${total} ${total === 1 ? 'person' : 'people'}. ${failed} could not be ${verb[1]}${why} They are still selected.`;
}
