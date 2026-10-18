import { describe, expect, it, vi } from 'vitest';
vi.mock('./auth-client', () => ({ apiFetch: vi.fn() }));
import { CommandQueue, voteValues } from './collaboration-commands';
import { capabilitiesForRole } from './collaboration-types';
import { emptyCollaborationState, type PublicCollaborationState } from './room-collaboration';

const round = (myVotes: string[]) => ({ id: 'vote:1', status: 'running' as const, title: 'Vote', targets: ['a', 'b'], votesPerUser: 3, maxPerTarget: 1, anonymous: true, startedBy: 'ana', startedAt: 'now', endsAt: null, endedAt: null, myVotes, results: null, voterNames: null, votedCount: 0 });
const state = (revision: number, myVotes: string[]) => ({ ...emptyCollaborationState(), revision, voteRounds: [round(myVotes)], brainstorm: null, participants: [], capabilities: capabilitiesForRole('editor'), currentUserId: 'bo' }) as PublicCollaborationState;

describe('collaboration command queue', () => {
  it('adds up quick successive votes instead of replacing them', async () => {
    const sent: string[][] = [];
    let ballot: string[] = [];
    const queue = new CommandQueue(state(1, []), async (_action, values) => {
      ballot = values.targets as string[];
      sent.push(ballot);
      return { state: state(1 + sent.length, ballot) };
    });
    // Both clicks happen before either response arrives (render-time ballot is []).
    await Promise.all([
      queue.run('cast_vote', voteValues(votes => [...votes, 'a'])),
      queue.run('cast_vote', voteValues(votes => [...votes, 'b'])),
    ]);
    expect(sent).toEqual([['a'], ['a', 'b']]);
  });

  it('ignores a double click, runs in order, and keeps errors from a burst', async () => {
    const order: string[] = [];
    const errors: string[] = [];
    const queue = new CommandQueue(state(1, []), async action => {
      order.push(action);
      if (action === 'fails') throw new Error('Nope');
      return {};
    }, { error: message => errors.push(message) });
    const results = await Promise.all([queue.run('submit', { id: 1 }), queue.run('submit', { id: 1 }), queue.run('fails'), queue.run('after')]);
    expect(order).toEqual(['submit', 'fails', 'after']);
    expect(results.map(Boolean)).toEqual([true, false, false, true]);
    // The failure is not cleared by the command queued after it.
    expect(errors.filter(Boolean)).toEqual(['Nope']);
    expect(errors.at(-1)).toBe('Nope');
  });
});
