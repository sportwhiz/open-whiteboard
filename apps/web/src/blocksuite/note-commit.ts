/**
 * Notes this person created in this session, reported once: on the first
 * time they finish writing one. Notes from collaborators, notes that were
 * on the board when it loaded, and later edits are never reported.
 */
export function createNoteCommitTracker() {
  const pending = new Set<string>();
  const reported = new Set<string>();
  return {
    /** A note block appeared; only local, post-load additions count. */
    added(id: string, isLocal: boolean, init = false) {
      if (isLocal && !init && !reported.has(id)) pending.add(id);
    },
    /** An edit of this note ended. True the one time it should be reported. */
    ended(id: string, text: string) {
      // An empty note has nothing to share yet; wait for words.
      if (!pending.has(id) || !text.trim()) return false;
      pending.delete(id);
      reported.add(id);
      return true;
    },
  };
}
