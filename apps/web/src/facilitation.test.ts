import { describe, expect, it } from 'vitest';
import { capabilitiesForRole } from './collaboration-types';
import { defaultVoteTargets, facilitation, presenceOrder, runningActivities, workshopIsLive } from './facilitation';
import { emptyCollaborationState, type PublicCollaborationState } from './room-collaboration';

const here = (id: string) => ({ id, name: id, connectionId: `c-${id}`, avatarUrl: null, color: '#000000', role: 'editor' as const, idle: false });
const base = (overrides: Partial<PublicCollaborationState> = {}): PublicCollaborationState => ({
  ...emptyCollaborationState(), voteRounds: [], brainstorm: null, participants: [here('ana'), here('bo')], capabilities: capabilitiesForRole('editor'), currentUserId: 'bo', ...overrides,
}) as PublicCollaborationState;
const timer = { status: 'running' as const, label: 'Warm-up', startedBy: 'ana', startedAt: 'now', endsAt: new Date(Date.now() + 60_000).toISOString(), remainingMs: 60_000 };

describe('facilitation controls', () => {
  it('belong to whoever runs the session, and board owners', () => {
    expect(facilitation(base({ facilitatorId: 'ana', timer })).leads).toBe(false);
    expect(facilitation(base({ facilitatorId: 'ana', timer })).canTakeOver).toBe(true);
    expect(facilitation(base({ facilitatorId: 'bo', timer })).leads).toBe(true);
    expect(facilitation(base({ facilitatorId: 'ana', timer, capabilities: capabilitiesForRole('owner') })).leads).toBe(true);
  });
  it('falls back to who started the running activity in older stored state', () => {
    expect(facilitation(base({ timer })).facilitatorId).toBe('ana');
    expect(facilitation(base({ timer })).leads).toBe(false);
  });
  it('expires: nothing running, or the facilitator left, means anyone can lead', () => {
    expect(facilitation(base({ facilitatorId: 'ana' })).leads).toBe(true);
    expect(facilitation(base({ facilitatorId: 'ana', timer, participants: [here('bo')] })).leads).toBe(true);
    // Someone who took over leads while they are here.
    expect(facilitation(base({ facilitatorId: 'cy', timer, participants: [here('ana'), here('bo'), here('cy')] })).facilitatorId).toBe('cy');
  });
  it('lets any editor start the first activity, and never viewers', () => {
    expect(facilitation(base()).leads).toBe(true);
    const viewer = facilitation(base({ capabilities: capabilitiesForRole('viewer') }));
    expect(viewer.leads).toBe(false);
    expect(viewer.canTakeOver).toBe(false);
  });
});

describe('activity notices', () => {
  const brainstorm = { id: 'b1', status: 'running' as const, title: 'Ideas', instructions: '', startedBy: 'ana', startedAt: 'now', endsAt: null, closedAt: null, revealedAt: null, revealedIds: [], myDrafts: [], submittedCount: 0, participantCount: 0, unsubmittedCount: 0, unsubmittedPeople: 0, writingCount: 0 };
  it('tells participants what is running and what to do', () => {
    const now = Date.now();
    const items = runningActivities(base({ brainstorm: { ...brainstorm, endsAt: new Date(now + 150_000).toISOString() } }), { now, followingUserId: null });
    // The countdown is separate from the label, so it is not announced or used as a key.
    expect(items).toEqual([expect.objectContaining({ kind: 'brainstorm', label: 'Private brainstorm', detail: '3 min left', action: 'Add a private idea', hint: 'Notes you put on the board are visible to everyone.' })]);
    expect(runningActivities(base({ brainstorm: { ...brainstorm, endsAt: new Date(now - 1).toISOString() } }), { now, followingUserId: null })[0].detail).toBe('time is up');
  });
  it('offers to join a presentation you are not following', () => {
    const presentation = { id: 'p1', status: 'running' as const, presenterId: 'ana', frameIds: ['f'], frameIndex: 0, viewport: null, updatedAt: 'now' };
    const state = base({ presentation, participants: [{ ...here('ana'), name: 'Ana' }] });
    expect(runningActivities(state, { now: 0, followingUserId: null })[0]).toMatchObject({ label: 'Ana is presenting', action: 'Join' });
    expect(runningActivities(state, { now: 0, followingUserId: 'ana' })).toEqual([]);
  });
  it('marks the workshop live while anything runs', () => {
    expect(workshopIsLive(base())).toBe(false);
    expect(workshopIsLive(base({ timer }))).toBe(true);
  });
});

describe('vote targets', () => {
  const notes = ['n1', 'n2', 'n3', 'n4'];
  it('defaults to the ideas just revealed, then the selection, then all', () => {
    expect(defaultVoteTargets(notes, { revealedIds: ['frame', 'n3', 'n4'] })).toEqual({ source: 'revealed', targets: ['n3', 'n4'] });
    expect(defaultVoteTargets(notes, { selection: ['n2'] })).toEqual({ source: 'selection', targets: ['n2'] });
    expect(defaultVoteTargets(notes, {})).toEqual({ source: 'all', targets: notes });
  });
  it('never exceeds what a vote can hold', () => {
    const many = Array.from({ length: 140 }, (_, index) => `n${index}`);
    expect(defaultVoteTargets(many, {}).targets).toHaveLength(100);
  });
});

describe('presence order', () => {
  it('is stable: you first, then by name', () => {
    const people = [{ id: 'z', name: 'Zoe' }, { id: 'me', name: 'Moe' }, { id: 'a', name: 'Al' }];
    expect(presenceOrder(people, 'me').map(person => person.id)).toEqual(['me', 'a', 'z']);
  });
});
