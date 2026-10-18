import { describe, expect, it } from 'vitest';
import { SqliteCatalog } from '../src/node/sqlite-catalog';
import { VIEWER_PARTICIPATION_MESSAGE } from '../src/board-room';
import { capabilitiesForRole } from '../src/collaboration-types';
import { owner, person, roomWith, storages, type Storage } from './room-harness';

const ana = person('ana', 'Ana');
const vi = person('vi', 'Vi Viewer');
const socketFor = (principal: ReturnType<typeof person>, role: 'owner' | 'editor' | 'viewer' = 'editor') => ({
  deserializeAttachment: () => ({ boardId: 'board-1', principal, capabilities: capabilitiesForRole(role), connectionId: `c-${principal.id}`, presence: { idle: false }, authorizationCheckedAt: Date.now() }),
  send() {}, close() {},
});

describe.each(storages)('roles and presence on %s', (_name, makeStorage) => {
  const storage = () => (makeStorage as () => Storage)();

  it('lets viewers follow along but not add ideas or vote', async () => {
    const { command } = await roomWith(storage());
    await command(ana, 'start_brainstorm', { title: 'Ideas' });
    const draft = await command(vi, 'save_draft', { text: 'Sneaky idea' }, 'viewer');
    expect(draft.status).toBe(400);
    expect(draft.body.error).toBe(VIEWER_PARTICIPATION_MESSAGE);
    expect((await command(vi, 'brainstorm_writing', { writing: true }, 'viewer')).status).toBe(400);
    const roundId = (await command(ana, 'start_vote', { targets: ['note:1'] })).body.state.voteRounds[0].id;
    expect((await command(vi, 'cast_vote', { roundId, targets: ['note:1'] }, 'viewer')).status).toBe(400);
    // Reactions and hands stay open to everyone.
    expect((await command(vi, 'raise_hand', {}, 'viewer')).status).toBe(200);
    expect((await command(vi, 'reaction', { emoji: '👍' }, 'viewer')).status).toBe(200);
    // Commenters participate.
    expect((await command(person('co'), 'save_draft', { text: 'Commenter idea' }, 'commenter')).status).toBe(200);
  });

  it('ends a presentation when its presenter leaves for good, not on a reload', async () => {
    const store = storage();
    const sockets: unknown[] = [socketFor(owner, 'owner'), socketFor(ana)];
    const { room, command, read } = await roomWith(store, sockets);
    const presenterSocket = sockets[0];
    await command(owner, 'start_presentation', { frameIds: ['frame:1'] }, 'owner');
    // A reload: the old connection closes, a new one opens within the grace period.
    sockets.splice(0, 1);
    await room.webSocketClose(presenterSocket as WebSocket);
    expect((await read(ana)).presentation.presenterLeftAt).toBeTruthy();
    sockets.push(socketFor(owner, 'owner'));
    await (room as unknown as { checkPresenter(): Promise<void> }).checkPresenter();
    await room.alarm();
    expect((await read(ana)).presentation).toMatchObject({ status: 'running', presenterLeftAt: null });
    // Gone for good: after the grace period the presentation ends, with a reason.
    sockets.splice(sockets.length - 1, 1);
    (room as unknown as { presenterGraceMs: number }).presenterGraceMs = 0;
    await room.webSocketClose(presenterSocket as WebSocket);
    expect((await read(ana)).presentation).toMatchObject({ status: 'ended', endedReason: 'presenter-left' });
  });
});

describe('mentions reach people who are offline', () => {
  it('notifies a mentioned member who is not on the board, and no one without access', async () => {
    const db = new SqliteCatalog(':memory:');
    await db.exec(`
      CREATE TABLE boards(id TEXT, title TEXT, workbook_id TEXT, deleted_at TEXT, inheritance_disabled INTEGER);
      CREATE TABLE workbooks(id TEXT, title TEXT, deleted_at TEXT);
      CREATE TABLE resource_grants(resource_type TEXT, resource_id TEXT, user_id TEXT, role TEXT, expires_at TEXT);
      CREATE TABLE users(id TEXT, display_name TEXT, color TEXT, email TEXT);
      CREATE TABLE local_accounts(user_id TEXT, username TEXT);
      CREATE TABLE notifications(id TEXT, user_id TEXT, board_id TEXT, kind TEXT, title TEXT, body TEXT, href TEXT, event_key TEXT UNIQUE, created_at TEXT, read_at TEXT);
      CREATE TABLE comment_subscriptions(thread_id TEXT, board_id TEXT, user_id TEXT, muted INTEGER, updated_at TEXT, PRIMARY KEY(thread_id, user_id));
      INSERT INTO boards VALUES ('board-1', 'Board', 'wb', NULL, 0);
      INSERT INTO workbooks VALUES ('wb', 'Team', NULL);
      INSERT INTO users VALUES ('owner', 'Facilitator', '#111111', 'f@example.test'), ('mia', 'Mia Member', '#222222', 'm@example.test'), ('out', 'Outsider', '#333333', 'o@example.test');
      INSERT INTO local_accounts VALUES ('mia', 'mia');
      INSERT INTO resource_grants VALUES ('board', 'board-1', 'owner', 'owner', NULL), ('board', 'board-1', 'mia', 'commenter', NULL);
    `);
    const { command } = await roomWith((storages[0][1] as () => Storage)(), [], db as unknown as D1Database);
    expect((await command(owner, 'add_comment', { body: 'Can @mia and @Outsider look?', mentions: ['out'] }, 'owner')).status).toBe(200);
    const rows = await db.prepare("SELECT user_id AS userId, kind FROM notifications").all<{ userId: string; kind: string }>();
    expect(rows.results).toEqual([{ userId: 'mia', kind: 'mention' }]);
  });
});
