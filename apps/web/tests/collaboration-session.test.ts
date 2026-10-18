import { BoardRoom } from '../src/board-room';
import { applyNativeOperations, readNativeBoard } from '../src/native-operations.server';
import type { NativeBoardSnapshot } from '../src/blocksuite/runtime/snapshot';
import { reportWriting } from '../src/brainstorm-writing';
import { catalog } from './room-harness';
import { describe, expect, it, vi } from 'vitest';
import { parseCollaborationArchive } from '../src/collaboration-archive.server';
import { emptyCollaborationState } from '../src/room-collaboration';
import { capabilitiesForRole } from '../src/collaboration-types';
import { owner, person, roomWith, storages, type Storage } from './room-harness';

const ana = person('ana', 'Ana');
const bo = person('bo', 'Bo');

describe('rollback-safe collaboration fields', () => {
  it('parses state with and without the new optional fields', () => {
    const base = emptyCollaborationState();
    expect(parseCollaborationArchive(base)).not.toBeNull();
    const withNew = { ...base, facilitatorId: 'ana', brainstorm: { id: 'b', status: 'running', title: 't', instructions: '', startedBy: 'ana', startedAt: 'now', endsAt: null, closedAt: null, revealedAt: null, drafts: {}, revealedIds: [], writing: { bo: 'now' } } };
    expect(parseCollaborationArchive(withNew)?.facilitatorId).toBe('ana');
    // An older version strips keys it does not know instead of rejecting the archive.
    expect(parseCollaborationArchive({ ...withNew, somethingFromTheFuture: true })).not.toBeNull();
  });
});

describe.each(storages)('workshop sessions on %s', (_name, makeStorage) => {
  const fresh = () => roomWith((makeStorage as () => Storage)());

  it('records who is facilitating, and lets another editor take over', async () => {
    const { command, read } = await fresh();
    expect((await command(ana, 'start_timer', { durationSeconds: 60, label: 'Retro warm-up' })).status).toBe(200);
    let state = await read(bo);
    expect(state.facilitatorId).toBe('ana');
    expect(state.timer.label).toBe('Retro warm-up');
    expect((await command(bo, 'take_facilitation')).status).toBe(200);
    state = await read(bo);
    expect(state.facilitatorId).toBe('bo');
    expect(state.activity[0].summary).toBe('Bo took over facilitation');
    // Viewers cannot take over.
    expect((await command(person('vi'), 'take_facilitation', {}, 'viewer')).status).toBe(400);
  });

  it('keeps collection open past the time limit, and can close and reopen it', async () => {
    const { room, command, read } = await fresh();
    await command(ana, 'start_brainstorm', { title: 'Ideas', durationSeconds: 1 });
    await new Promise(resolve => setTimeout(resolve, 1100));
    await room.alarm();
    expect((await read(bo)).brainstorm.status).toBe('running');
    const saved = await command(bo, 'save_draft', { text: 'Finished after the bell' });
    expect(saved.status).toBe(200);
    expect((await command(ana, 'close_brainstorm')).status).toBe(200);
    // Saved ideas can still be submitted after collection closes.
    const draftId = (await read(bo)).brainstorm.myDrafts[0].id;
    expect((await command(bo, 'submit_draft', { draftId })).status).toBe(200);
    expect((await command(bo, 'save_draft', { text: 'New idea' })).status).toBe(400);
    expect((await command(ana, 'reopen_brainstorm')).status).toBe(200);
    const reopened = await read(bo);
    expect(reopened.brainstorm.status).toBe('running');
    expect(reopened.brainstorm.submittedCount).toBe(1);
    expect((await command(bo, 'save_draft', { text: 'New idea' })).status).toBe(200);
  });

  it('tells the facilitator who is still writing and what is unsubmitted', async () => {
    const storage = (makeStorage as () => Storage)();
    const sockets = [ana, bo].map(principal => ({ deserializeAttachment: () => ({ boardId: 'board-1', principal, capabilities: capabilitiesForRole('editor'), connectionId: `c-${principal.id}`, presence: { idle: false }, authorizationCheckedAt: Date.now() }), send() {}, close() {} }));
    const { command, read } = await roomWith(storage, sockets);
    await command(ana, 'start_brainstorm', { title: 'Ideas' });
    await command(bo, 'save_draft', { text: 'Unsubmitted idea' });
    await command(bo, 'brainstorm_writing', { writing: true });
    let state = (await read(ana)).brainstorm;
    expect(state).toMatchObject({ writingCount: 1, unsubmittedCount: 1, unsubmittedPeople: 1, submittedCount: 0 });
    expect(state.writing).toBeUndefined();
    await command(bo, 'brainstorm_writing', { writing: false });
    state = (await read(ana)).brainstorm;
    expect(state.writingCount).toBe(0);
  });

  it('shows voting progress without revealing choices', async () => {
    const { command, read } = await fresh();
    const started = await command(ana, 'start_vote', { targets: ['note:1', 'note:2'], votesPerUser: 2 });
    const roundId = started.body.state.voteRounds[0].id;
    await command(bo, 'cast_vote', { roundId, targets: ['note:1'] });
    await command(person('cy'), 'cast_vote', { roundId, targets: [] });
    const round = (await read(ana)).voteRounds[0];
    expect(round.results).toBeNull();
  });

  it('lowers a hand when its owner leaves, but not on a quick reconnect', async () => {
    const storage = (makeStorage as () => Storage)();
    const session = { boardId: 'board-1', principal: bo, capabilities: capabilitiesForRole('editor'), connectionId: 'c-bo', presence: { idle: false } };
    const socket = { deserializeAttachment: () => session, send() {}, close() {} };
    const sockets: unknown[] = [];
    const { room, command } = await roomWith(storage, sockets);
    const hands = async () => Object.keys((await storage.get<{ raisedHands: Record<string, string> }>('collaboration'))!.raisedHands);
    await command(bo, 'raise_hand');
    // Within the grace period, and back again (a reload): the hand stays.
    await room.webSocketClose(socket as unknown as WebSocket);
    sockets.push({ ...socket });
    await room.alarm();
    expect(await hands()).toEqual(['bo']);
    // Gone for good: the alarm lowers it once the grace period has passed.
    sockets.length = 0;
    (room as unknown as { handGraceMs: number }).handGraceMs = 0;
    await room.webSocketClose(socket as unknown as WebSocket);
    expect(await hands()).toEqual([]);
  });

  it('keeps "still writing" out of storage and receipts', async () => {
    const storage = (makeStorage as () => Storage)();
    const sockets = [ana, bo].map(principal => ({ deserializeAttachment: () => ({ boardId: 'board-1', principal, capabilities: capabilitiesForRole('editor'), connectionId: `c-${principal.id}`, presence: { idle: false }, authorizationCheckedAt: Date.now() }), send() {}, close() {} }));
    const { command, read } = await roomWith(storage, sockets);
    await command(ana, 'start_brainstorm', { title: 'Ideas' });
    const before = await storage.get<{ revision: number }>('collaboration');
    expect((await command(bo, 'brainstorm_writing', { writing: true })).status).toBe(200);
    const after = await storage.get<{ revision: number; brainstorm: Record<string, unknown> }>('collaboration');
    expect(after!.revision).toBe(before!.revision);
    expect(after!.brainstorm.writing).toBeUndefined();
    expect((await read(ana)).brainstorm.writingCount).toBe(1);
  });

  it('counts votes from people who are here', async () => {
    const storage = (makeStorage as () => Storage)();
    const sockets = [ana, bo].map(principal => ({ deserializeAttachment: () => ({ boardId: 'board-1', principal, capabilities: capabilitiesForRole('editor'), connectionId: `c-${principal.id}`, presence: { idle: false }, authorizationCheckedAt: Date.now() }), send() {}, close() {} }));
    const { command, read } = await roomWith(storage, sockets);
    const roundId = (await command(ana, 'start_vote', { targets: ['note:1'] })).body.state.voteRounds[0].id;
    await command(bo, 'cast_vote', { roundId, targets: ['note:1'] });
    await command(person('gone'), 'cast_vote', { roundId, targets: ['note:1'] });
    expect((await read(ana)).voteRounds[0].votedCount).toBe(1);
  });
  it('moves the current sticky into a private idea and refuses stale text', async () => {
    const storage = (makeStorage as () => Storage)();
    const { command, read } = await roomWith(storage);
    const board = (await storage.get<{ revision: number; snapshot: NativeBoardSnapshot }>('board'))!;
    const applied = applyNativeOperations(board.snapshot, [{ type: 'create_note', text: 'Later edits', ref: 'note', x: 0, y: 0 }]);
    const noteId = applied.refs.note;
    await storage.put('board', { ...board, revision: board.revision + 1, snapshot: applied.snapshot });
    await command(ana, 'start_brainstorm');
    expect((await command(ana, 'move_note_to_draft', { noteId, expectedText: 'First text' })).status).toBe(400);
    const notes = async () => readNativeBoard((await storage.get<{ snapshot: NativeBoardSnapshot }>('board'))!.snapshot).notes;
    expect((await notes())[0].text).toBe('Later edits');
    expect((await read(ana)).brainstorm.myDrafts).toHaveLength(0);
    expect((await command(bo, 'move_note_to_draft', { noteId, expectedText: 'Later edits' }, 'commenter')).status).toBe(400);
    const values = { noteId, expectedText: 'Later edits', operationId: 'move-note-once' };
    expect((await command(ana, 'move_note_to_draft', values)).status).toBe(200);
    expect(await notes()).toHaveLength(0);
    expect((await read(ana)).brainstorm.myDrafts.map((d: { text: string }) => d.text)).toEqual(['Later edits']);
    expect((await read(bo)).brainstorm.myDrafts).toHaveLength(0);
    expect((await command(ana, 'move_note_to_draft', values)).status).toBe(200);
    expect((await read(ana)).brainstorm.myDrafts).toHaveLength(1);
  });

  it.each(['webSocketClose', 'webSocketError'] as const)('remembers hand cleanup after %s and a room restart', async method => {
    const storage = (makeStorage as () => Storage)();
    const { room, command } = await roomWith(storage);
    const socket = { deserializeAttachment: () => ({ boardId: 'board-1', principal: bo, capabilities: capabilitiesForRole('editor'), connectionId: 'c-bo', presence: { idle: false } }), send() {} };
    await command(bo, 'raise_hand');
    await room[method](socket as unknown as WebSocket);
    const freshRoom = new BoardRoom({ storage, getWebSockets: () => [] } as unknown as DurableObjectState, { CATALOG: catalog });
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 9_000);
    try {
      await freshRoom.alarm();
      expect((await storage.get<{ raisedHands: object }>('collaboration'))!.raisedHands).toEqual({});
      expect(await storage.get('departed-hands')).toEqual({});
    } finally { now.mockRestore(); }
  });

  it('keeps writing presence current during a long draft and retries transient failures', async () => {
    const storage = (makeStorage as () => Storage)();
    const sockets = [ana, bo].map(principal => ({ deserializeAttachment: () => ({ boardId: 'board-1', principal, capabilities: capabilitiesForRole('editor'), connectionId: `c-${principal.id}`, presence: { idle: false }, authorizationCheckedAt: Date.now() }), send() {}, close() {} }));
    const { command, read } = await roomWith(storage, sockets);
    await command(ana, 'start_brainstorm');
    vi.useFakeTimers();
    let failFirst = true;
    const stop = reportWriting(async writing => {
      if (failFirst) { failFirst = false; throw new Error('Temporary connection failure'); }
      return command(bo, 'brainstorm_writing', { writing });
    }, true, `long-draft:${_name}`);
    try {
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect((await read(ana)).brainstorm.writingCount).toBe(1);
      stop();
      await vi.advanceTimersByTimeAsync(0);
      expect((await read(ana)).brainstorm.writingCount).toBe(0);
    } finally { stop(); vi.useRealTimers(); }
  });

  it('excludes viewers from voting progress, including downgraded voters', async () => {
    const storage = (makeStorage as () => Storage)();
    let role: 'editor' | 'viewer' = 'editor';
    const sockets = [ana, bo].map(principal => ({ deserializeAttachment: () => ({ boardId: 'board-1', principal, capabilities: capabilitiesForRole(principal.id === bo.id ? role : 'editor'), connectionId: `c-${principal.id}`, presence: { idle: false }, authorizationCheckedAt: Date.now() }), send() {}, close() {} }));
    const { command, read } = await roomWith(storage, sockets);
    const started = await command(ana, 'start_vote', { targets: ['note:1'] });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const roundId = started.body.state.voteRounds[0].id;
    await command(bo, 'cast_vote', { roundId, targets: ['note:1'] });
    expect((await read(ana)).voteRounds[0].votedCount).toBe(1);
    role = 'viewer';
    expect((await read(ana)).voteRounds[0].votedCount).toBe(0);
  });

});
