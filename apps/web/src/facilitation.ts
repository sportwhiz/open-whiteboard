import type { PublicCollaborationState } from './room-collaboration';

/**
 * Who runs the session. Server permissions let any editor facilitate (so
 * co-facilitation keeps working), but the controls are shown only to the
 * person running the current activity and to board owners. Other editors
 * can take over deliberately.
 */
export function facilitation(state: Pick<PublicCollaborationState, 'facilitatorId' | 'timer' | 'brainstorm' | 'voteRounds' | 'presentation' | 'capabilities' | 'currentUserId' | 'participants'>) {
  const running = [
    state.presentation?.status === 'running' ? state.presentation.presenterId : null,
    state.voteRounds.find(round => round.status === 'running')?.startedBy ?? null,
    state.brainstorm && ['running', 'closed'].includes(state.brainstorm.status) ? state.brainstorm.startedBy : null,
    state.timer && state.timer.status !== 'ended' ? state.timer.startedBy : null,
  ].filter((id): id is string => Boolean(id));
  // Someone runs the session only while an activity is running and they are
  // here; days later, or after they leave, any editor can simply start.
  const here = new Set(state.participants.map(person => person.id));
  here.add(state.currentUserId);
  const candidates = [state.facilitatorId, ...running].filter((id): id is string => Boolean(id) && here.has(id as string));
  const facilitatorId = running.length ? candidates[0] ?? null : null;
  const canFacilitate = state.capabilities.facilitate;
  const leads = canFacilitate && (state.capabilities.manage || !facilitatorId || facilitatorId === state.currentUserId);
  return { facilitatorId, leads, canTakeOver: canFacilitate && !leads };
}

export type WorkshopActivity = {
  id: string;
  kind: 'brainstorm' | 'vote' | 'presentation';
  label: string;
  /** Changes over time (a countdown); kept out of announcements. */
  detail?: string;
  /** A short, important note shown under the label. */
  hint?: string;
  action: string;
};

/**
 * Activities a participant should know about without opening a panel, in
 * order of importance. Shown as a quiet pill; never moves focus.
 */
export function runningActivities(state: PublicCollaborationState, options: { now: number; followingUserId: string | null }): WorkshopActivity[] {
  const items: WorkshopActivity[] = [];
  const presentation = state.presentation;
  if (presentation?.status === 'running' && presentation.presenterId !== state.currentUserId && options.followingUserId !== presentation.presenterId) {
    const presenter = state.participants.find(person => person.id === presentation.presenterId)?.name ?? 'Someone';
    items.push({ id: presentation.id, kind: 'presentation', label: `${presenter} is presenting`, action: 'Join' });
  }
  const brainstorm = state.brainstorm;
  if (brainstorm?.status === 'running') {
    const left = brainstorm.endsAt ? Math.ceil((Date.parse(brainstorm.endsAt) - options.now) / 60_000) : null;
    const detail = left === null ? undefined : left > 0 ? `${left} min left` : 'time is up';
    const mine = brainstorm.myDrafts.length;
    const canAdd = state.capabilities.comment;
    // Private mode is easy to mistake: say plainly that the board is public.
    items.push({ id: brainstorm.id, kind: 'brainstorm', label: 'Private brainstorm', detail,
      action: !canAdd ? 'Follow along' : mine ? `Your ideas (${mine})` : 'Add a private idea',
      hint: canAdd ? 'Notes you put on the board are visible to everyone.' : undefined });
  } else if (brainstorm?.status === 'closed' && brainstorm.myDrafts.some(draft => !draft.submittedAt)) {
    items.push({ id: brainstorm.id, kind: 'brainstorm', label: 'Collection closed', action: 'Submit your ideas' });
  }
  const vote = state.voteRounds.find(round => round.status === 'running');
  if (vote) {
    const left = Math.max(0, vote.votesPerUser - vote.myVotes.length);
    items.push({ id: vote.id, kind: 'vote', label: 'Vote open', action: !state.capabilities.comment ? 'See the vote' : left ? `${left} ${left === 1 ? 'vote' : 'votes'} left` : 'You voted' });
  }
  return items;
}

/** Whether something in the workshop is live (for the dot on the Workshop button). */
export function workshopIsLive(state: PublicCollaborationState) {
  return Boolean(
    (state.timer && state.timer.status !== 'ended') ||
    (state.brainstorm && ['running', 'closed'].includes(state.brainstorm.status)) ||
    state.voteRounds.some(round => round.status === 'running'),
  );
}

export type VoteSource = 'revealed' | 'selection' | 'all';

/**
 * Default ideas for a new vote: the ideas just revealed from a brainstorm,
 * otherwise what is selected on the canvas, otherwise every sticky (up to
 * the 100 a vote can hold).
 */
export function defaultVoteTargets(noteIds: string[], options: { revealedIds?: string[]; selection?: string[] }) {
  const known = new Set(noteIds);
  const revealed = (options.revealedIds ?? []).filter(id => known.has(id));
  if (revealed.length) return { source: 'revealed' as const, targets: revealed.slice(0, MAX_VOTE_TARGETS) };
  const selected = (options.selection ?? []).filter(id => known.has(id));
  if (selected.length) return { source: 'selection' as const, targets: selected.slice(0, MAX_VOTE_TARGETS) };
  return { source: 'all' as const, targets: noteIds.slice(0, MAX_VOTE_TARGETS) };
}

export const MAX_VOTE_TARGETS = 100;

/** Stable presence order: you first, then by name, so avatars never reshuffle. */
export function presenceOrder<T extends { id: string; name: string }>(people: T[], currentUserId: string) {
  return [...people].sort((a, b) => Number(b.id === currentUserId) - Number(a.id === currentUserId) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
