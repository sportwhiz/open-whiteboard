import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteCatalog } from '../src/node/sqlite-catalog';
import { listBoardPeople, mentionsInText, readMentionablePeople, roleForBoard } from '../src/collaboration.server';
import type { Principal } from '../src/collaboration-types';

let db: SqliteCatalog;
const principal = (id: string, authentication: Principal['authentication'] = 'native'): Principal => ({ id, email: `${id}@example.test`, name: id, avatarUrl: null, color: '#123456', issuer: 'test', subject: id, sessionId: 's', expiresAt: null, authentication });

beforeEach(async () => {
  db = new SqliteCatalog(':memory:');
  await db.exec(`
    CREATE TABLE boards(id TEXT, title TEXT, workbook_id TEXT, deleted_at TEXT, inheritance_disabled INTEGER);
    CREATE TABLE workbooks(id TEXT, title TEXT, deleted_at TEXT);
    CREATE TABLE resource_grants(resource_type TEXT, resource_id TEXT, user_id TEXT, role TEXT, expires_at TEXT);
    CREATE TABLE users(id TEXT, display_name TEXT, color TEXT, email TEXT);
    CREATE TABLE local_accounts(user_id TEXT, username TEXT);
    INSERT INTO workbooks VALUES ('wb', 'Team', NULL);
    INSERT INTO boards VALUES ('open', 'Open board', 'wb', NULL, 0), ('private', 'Private board', 'wb', NULL, 1);
    INSERT INTO users VALUES ('owner', 'Olive Owner', '#111111', 'olive@example.test'), ('mia', 'Mia Member', '#222222', 'mia@example.test'),
      ('wally', 'Wally Workbook', '#333333', 'wally@example.test'), ('ex', 'Expired Ed', '#444444', 'ed@example.test'), ('out', 'Outsider', '#555555', 'out@example.test');
    INSERT INTO local_accounts VALUES ('mia', 'mia');
    INSERT INTO resource_grants VALUES
      ('board', 'open', 'owner', 'owner', NULL), ('board', 'open', 'mia', 'commenter', NULL),
      ('workbook', 'wb', 'wally', 'viewer', NULL), ('board', 'open', 'ex', 'editor', '2000-01-01T00:00:00Z'),
      ('board', 'private', 'owner', 'owner', NULL), ('board', 'private', 'mia', 'editor', NULL);
  `);
});

describe('mentionable people', () => {
  it('includes everyone with access, online or not, and no one else', async () => {
    const people = await listBoardPeople(db as unknown as D1Database, 'open');
    expect(people.map(person => person.id).sort()).toEqual(['mia', 'owner', 'wally']);
    expect(people.find(person => person.id === 'mia')?.username).toBe('mia');
    expect(JSON.stringify(people)).not.toContain('@example.test');
  });
  it('excludes workbook members from a private board', async () => {
    const people = await listBoardPeople(db as unknown as D1Database, 'private');
    expect(people.map(person => person.id).sort()).toEqual(['mia', 'owner']);
    expect(await roleForBoard(db as unknown as D1Database, 'private', 'wally')).toBeNull();
  });
  it('is only available to commenters and up, and guests see no names', async () => {
    await expect(readMentionablePeople(db as unknown as D1Database, 'open', principal('wally'))).rejects.toThrow();
    expect((await readMentionablePeople(db as unknown as D1Database, 'open', principal('mia'))).people).toHaveLength(3);
  });
  it('shows sign-in usernames only to people who can share, and to each person for themselves', async () => {
    await db.exec(`INSERT INTO local_accounts VALUES ('owner', 'olive')`);
    const usernames = async (viewer: string) => Object.fromEntries((await readMentionablePeople(db as unknown as D1Database, 'open', principal(viewer))).people.map(person => [person.id, person.username]));
    expect(await usernames('owner')).toMatchObject({ owner: 'olive', mia: 'mia' });
    expect(await usernames('mia')).toMatchObject({ owner: null, mia: 'mia' });
  });
});

describe('mentions in text', () => {
  const people = [{ id: 'mia', name: 'Mia Member', username: 'mia' }, { id: 'mi', name: 'Mi', username: null }, { id: 'owner', name: 'Olive Owner', username: null }];
  it('reads usernames and display names, longest first', () => {
    expect(mentionsInText('Thanks @mia!', people)).toEqual(['mia']);
    expect(mentionsInText('@Mia Member can you check?', people)).toEqual(['mia']);
    expect(mentionsInText('cc @olive owner, @mi', people).sort()).toEqual(['mi', 'owner']);
  });
  it('ignores email addresses and partial words', () => {
    expect(mentionsInText('write to someone@mia.example', people)).toEqual([]);
    expect(mentionsInText('@miami trip', people)).toEqual([]);
  });
});
