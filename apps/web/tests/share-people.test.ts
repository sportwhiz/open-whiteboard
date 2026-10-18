import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInvitation, createWorkbookInvitation, searchSharePeople } from '../src/collaboration.server';
import type { Principal } from '../src/collaboration-types';
import { compileCatalogSql } from '../src/node/catalog-sql';

const migrationDirectory = new URL('../migrations/', import.meta.url);
const at = new Date().toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();
const future = new Date(Date.now() + 86_400_000).toISOString();

const native = (id: string, name = id): Principal => ({
  id, name, email: `${id}@example.test`, avatarUrl: null, color: '#4262ff', issuer: 'urn:canvas:account', subject: id,
  sessionId: 'session', expiresAt: null, authentication: 'native', authVersion: 1,
});

// Real migrations and service statements on SQLite. Batches are transactions,
// with a hook to commit a competing change after the service's reads. Every
// statement is also compiled for MySQL, so the Node package can run it.
function fixtureDatabase(db: DatabaseSync, beforeBatch: () => void) {
  const prepare = (sql: string, values: SQLInputValue[] = []) => {
    compileCatalogSql(sql);
    const changes = () => Number(db.prepare('SELECT changes() AS n').get()!.n);
    return {
      bind: (...next: SQLInputValue[]) => prepare(sql, next),
      first: async () => db.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...values) }),
      run: async () => { db.prepare(sql).run(...values); return { success: true, meta: { changes: changes() } }; },
      execute: () => {
        const results = db.prepare(sql).all(...values);
        return { success: true, results, meta: { changes: changes() } };
      },
    };
  };
  return {
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) => {
      beforeBatch();
      db.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.execute());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

type Account = { id: string; name: string; email?: string; username?: string; verified?: boolean; status?: string; recovery?: boolean; membership?: 'owner' | 'admin' | 'member' | 'guest' | null };
const accounts: Account[] = [
  { id: 'owner', name: 'Olivia Owner', membership: 'owner' },
  { id: 'mia', name: 'Mia Member' },
  { id: 'adam', name: 'Adam Admin', membership: 'admin' },
  { id: 'gail', name: 'Gail Guest', membership: 'guest' },
  { id: 'sam', name: 'Sam Suspended', status: 'suspended' },
  { id: 'pete', name: 'Pete Pending', status: 'pending_approval', membership: null },
  { id: 'una', name: 'Una Unverified', verified: false },
  { id: 'rory', name: 'Rory Recovery', recovery: true },
  { id: 'lou', name: 'Lou Local', username: 'lou_local', verified: false },
  { id: 'pct', name: 'Percy 100%_Off' },
  { id: 'vera', name: 'Vera Viewer' },
];

describe('sharing with Studio accounts', () => {
  let db: DatabaseSync;
  let database: D1Database;
  let competingCommit: () => void;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort())
      db.exec(readFileSync(new URL(name, migrationDirectory), 'utf8'));
    db.exec("UPDATE installation SET state = 'ready'");
    for (const account of accounts) {
      const email = account.username ? `${account.id}-0000@local.huddleloom.invalid` : account.email ?? `${account.id}@example.test`;
      db.prepare('INSERT INTO auth_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run(account.id, account.name, email, account.verified === false ? 0 : 1, at, at);
      db.prepare("INSERT INTO users(id,issuer,subject,email,display_name,color,created_at,updated_at) VALUES (?,'urn:canvas:account',?,?,?,'#4262ff',?,?)").run(account.id, account.id, email, account.name, at, at);
      db.prepare('INSERT INTO account_security(user_id,status,recovery_required,created_at,updated_at) VALUES (?,?,?,?,?)').run(account.id, account.status ?? 'active', account.recovery ? 1 : 0, at, at);
      if (account.membership !== null) db.prepare('INSERT INTO instance_memberships(user_id,role,created_at) VALUES (?,?,?)').run(account.id, account.membership ?? 'member', at);
      if (account.username) db.prepare('INSERT INTO local_accounts(user_id,username) VALUES (?,?)').run(account.id, account.username);
    }
    db.prepare("INSERT INTO workbooks(id,title,created_at) VALUES ('workbook','Planning',?)").run(at);
    db.prepare("INSERT INTO boards(id,workbook_id,title,created_at,updated_at,created_by) VALUES ('board','workbook','Q4 planning',?,?,'owner')").run(at, at);
    db.prepare("INSERT INTO resource_grants(resource_type,resource_id,user_id,role,created_at,updated_at) VALUES ('board','board','owner','owner',?,?), ('workbook','workbook','owner','owner',?,?), ('board','board','vera','viewer',?,?)").run(at, at, at, at, at, at);
    competingCommit = () => {};
    database = fixtureDatabase(db, () => competingCommit());
  });
  afterEach(() => db.close());

  const owner = native('owner', 'Olivia Owner');
  const search = (q: string, principal = owner, type: 'board' | 'workbook' = 'board') => searchSharePeople(database, type, type, principal, q).then(result => result.people);
  const ids = (q: string, principal = owner) => search(q, principal).then(people => people.map(person => person.id).sort());
  const grant = (user: string, type = 'board') => db.prepare('SELECT role, source, expires_at AS expiresAt FROM resource_grants WHERE resource_type = ? AND resource_id = ? AND user_id = ?').get(type, type, user) ?? null;
  const count = (table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  const share = (body: Record<string, unknown>, principal = owner) => createInvitation(database, 'board', principal, body);

  describe('people search', () => {
    it('is only available to people who can share the resource', async () => {
      await expect(search('mia', native('vera'))).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
      await expect(search('mia', native('mia'))).rejects.toMatchObject({ status: 404 });
      await expect(search('mia', native('mia'), 'workbook')).rejects.toMatchObject({ status: 404 });
    });

    it('finds members by name, email and username, never the caller', async () => {
      expect(await ids('Mia Member')).toEqual(['mia']);
      expect(await ids('mia@exam')).toEqual(['mia']);
      expect(await ids('LOU_LO')).toEqual(['lou']);
      expect(await ids('olivia')).toEqual([]);
      const [mia] = await search('mia');
      expect(mia).toEqual({ id: 'mia', name: 'Mia Member', handle: 'mia@example.test', color: '#4262ff', avatarUrl: null, role: null, inherited: false });
      // Local accounts carry a placeholder address; it is never searchable or shown.
      expect(await ids('huddleloom')).toEqual([]);
      expect((await search('lou'))[0].handle).toBe('lou_local');
    });

    it('shows guests only for an exact username or email', async () => {
      expect(await ids('gail')).toEqual([]);
      expect(await ids('Gail Guest')).toEqual([]);
      expect(await ids('GAIL@example.test')).toEqual(['gail']);
    });

    it('excludes suspended, unadmitted, unverified and recovering accounts, even on an exact match', async () => {
      for (const id of ['sam', 'pete', 'una', 'rory']) {
        expect(await ids(id)).toEqual([]);
        expect(await ids(`${id}@example.test`)).toEqual([]);
      }
    });

    it('treats % and _ as literal characters', async () => {
      expect(await ids('%')).toEqual(['pct']);
      expect(await ids('0%_')).toEqual(['pct']);
      expect(await ids('_')).toEqual(['lou', 'pct']);
    });

    it('limits guest callers to exact matches', async () => {
      db.prepare("INSERT INTO resource_grants(resource_type,resource_id,user_id,role,created_at,updated_at) VALUES ('workbook','workbook','gail','owner',?,?)").run(at, at);
      const guest = native('gail');
      expect(await search('mia', guest, 'workbook')).toEqual([]);
      expect((await search('mia@example.test', guest, 'workbook')).map(person => person.id)).toEqual(['mia']);
    });

    it('reports current access, including access through the workbook', async () => {
      db.prepare("INSERT INTO resource_grants(resource_type,resource_id,user_id,role,created_at,updated_at) VALUES ('workbook','workbook','mia','editor',?,?), ('board','board','adam','commenter',?,?)").run(at, at, at, at);
      expect((await search('mia'))[0]).toMatchObject({ role: 'editor', inherited: true });
      expect((await search('adam'))[0]).toMatchObject({ role: 'commenter', inherited: false });
      expect((await search('vera'))[0]).toMatchObject({ role: 'viewer', inherited: false });
      db.exec("UPDATE boards SET inheritance_disabled = 1");
      expect((await search('mia'))[0]).toMatchObject({ role: null, inherited: false });
    });

    it('bounds the query and the result size', async () => {
      await expect(search('x'.repeat(101))).rejects.toMatchObject({ status: 400 });
      expect(await search('   ')).toEqual([]);
      for (let index = 0; index < 12; index++) {
        const id = `many${index}`;
        db.prepare("INSERT INTO auth_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)").run(id, `Many ${index}`, `${id}@example.test`, at, at);
        db.prepare("INSERT INTO users(id,issuer,subject,email,display_name,color,created_at,updated_at) VALUES (?,'urn:canvas:account',?,?,?,'#4262ff',?,?)").run(id, id, `${id}@example.test`, `Many ${index}`, at, at);
        db.prepare("INSERT INTO account_security(user_id,status,created_at,updated_at) VALUES (?,'active',?,?)").run(id, at, at);
        db.prepare("INSERT INTO instance_memberships(user_id,role,created_at) VALUES (?,'member',?)").run(id, at);
      }
      expect(await search('many')).toHaveLength(8);
    });

    it('rate limits searches', async () => {
      db.prepare('INSERT INTO request_limits (key, bucket, count, updated_at) VALUES (?, ?, 120, ?)').run('owner:share-people', Math.floor(Date.now() / 60_000), at);
      await expect(search('mia')).rejects.toMatchObject({ status: 429 });
    });

    it('keeps development search usable and Cloudflare Access search exact', async () => {
      const development = { ...owner, authentication: 'local-development' as const };
      const access = { ...owner, authentication: 'cloudflare-access' as const };
      expect(await ids('mia', development)).toEqual(['mia']);
      expect(await ids('mia', access)).toEqual([]);
      expect(await ids('mia@example.test', access)).toEqual(['mia']);
      expect(await ids('sam@example.test', development)).toEqual([]);
    });

    it('outside native mode grants a picked person directly, while a typed address stays a link', async () => {
      const development = { ...owner, authentication: 'local-development' as const };
      expect(await share({ email: 'mia@example.test', role: 'viewer' }, development)).toMatchObject({ granted: false, status: 'pending' });
      expect(grant('mia')).toBeNull();
      expect(await share({ userId: 'mia', role: 'viewer' }, development)).toMatchObject({ granted: true, changed: true });
      expect(grant('mia')).toMatchObject({ role: 'viewer', source: 'direct' });
      await expect(share({ userId: 'sam', role: 'viewer' }, development)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('direct sharing', () => {
    it('grants an admitted account at once, notifies them and audits it', async () => {
      const result = await share({ userId: 'mia', role: 'editor' });
      expect(result).toMatchObject({ granted: true, changed: true, notified: true, collaborator: { id: 'mia', name: 'Mia Member', email: 'mia@example.test', role: 'editor', source: 'direct', expiresAt: null } });
      expect('token' in result).toBe(false);
      expect(grant('mia')).toEqual({ role: 'editor', source: 'direct', expiresAt: null });
      expect(count('invitations')).toBe(0);
      expect(db.prepare("SELECT user_id, board_id, kind, title, body, href FROM notifications").all()).toEqual([
        { user_id: 'mia', board_id: 'board', kind: 'share', title: 'Olivia Owner shared “Q4 planning”', body: 'You can now edit it.', href: '/boards/board' },
      ]);
      expect(db.prepare("SELECT actor_id, action, target_id, outcome, metadata FROM security_audit").all()).toEqual([
        { actor_id: 'owner', action: 'board.shared', target_id: 'board', outcome: 'success', metadata: '{"role":"editor","recipientId":"mia"}' },
      ]);
    });

    it('resolves a typed email or username to the account', async () => {
      expect(await share({ email: 'MIA@example.test', role: 'viewer' })).toMatchObject({ granted: true, collaborator: { id: 'mia' } });
      expect(await share({ email: 'lou_local', role: 'commenter' })).toMatchObject({ granted: true, collaborator: { id: 'lou', email: 'lou_local' } });
      expect(grant('lou')).toMatchObject({ role: 'commenter' });
      expect(db.prepare("SELECT body FROM notifications WHERE user_id = 'lou'").get()!.body).toBe('You can now comment on it.');
      // A guest is shareable once the owner knows their exact address.
      expect(await share({ email: 'gail@example.test', role: 'viewer' })).toMatchObject({ granted: true });
    });

    it('never lowers access and writes nothing when the person already has it', async () => {
      await share({ userId: 'mia', role: 'editor' });
      const result = await share({ userId: 'mia', role: 'viewer' });
      expect(result).toMatchObject({ granted: true, changed: false, notified: false, collaborator: { role: 'editor' } });
      expect(grant('mia')).toMatchObject({ role: 'editor' });
      expect(count('notifications')).toBe(1);
      expect(count('security_audit')).toBe(1);
    });

    it('counts workbook access and leaves another owner grant untouched', async () => {
      db.prepare("INSERT INTO resource_grants(resource_type,resource_id,user_id,role,created_at,updated_at) VALUES ('workbook','workbook','mia','editor',?,?), ('board','board','adam','owner',?,?)").run(at, at, at, at);
      expect(await share({ userId: 'mia', role: 'commenter' })).toMatchObject({ changed: false, collaborator: { role: 'editor', source: 'workbook' } });
      expect(grant('mia')).toBeNull();
      expect(await share({ userId: 'adam', role: 'viewer' })).toMatchObject({ changed: false, collaborator: { role: 'owner' } });
      expect(grant('adam')).toMatchObject({ role: 'owner' });
      expect(count('security_audit')).toBe(0);
    });

    it('re-checks inside the write: an owner grant committed meanwhile is untouched', async () => {
      competingCommit = () => db.prepare("INSERT INTO resource_grants(resource_type,resource_id,user_id,role,created_at,updated_at) VALUES ('board','board','mia','owner',?,?)").run(at, at);
      expect(await share({ userId: 'mia', role: 'viewer' })).toMatchObject({ changed: false, collaborator: { role: 'owner' } });
      expect(grant('mia')).toMatchObject({ role: 'owner' });
      expect(count('notifications')).toBe(0);
      expect(count('security_audit')).toBe(0);
    });

    it('upgrades a lower or expired grant to the shared role without an expiry', async () => {
      db.prepare("INSERT INTO resource_grants(resource_type,resource_id,user_id,role,expires_at,created_at,updated_at) VALUES ('board','board','mia','viewer',?,?,?), ('board','board','adam','editor',?,?,?)").run(future, at, at, past, at, at);
      expect(await share({ userId: 'mia', role: 'editor' })).toMatchObject({ changed: true });
      expect(grant('mia')).toMatchObject({ role: 'editor', expiresAt: null });
      // Lapsed editor access is not revived by sharing view access.
      expect(await share({ userId: 'adam', role: 'viewer' })).toMatchObject({ changed: true, collaborator: { role: 'viewer' } });
      expect(grant('adam')).toMatchObject({ role: 'viewer', expiresAt: null });
    });

    it.each([
      ['the sharer loses ownership', () => db.exec("DELETE FROM resource_grants WHERE user_id = 'owner'")],
      ['the sharer is suspended', () => db.exec("UPDATE account_security SET status = 'suspended' WHERE user_id = 'owner'")],
      ['the sharer signs out everywhere', () => db.exec("UPDATE account_security SET auth_version = 2 WHERE user_id = 'owner'")],
      ['the recipient is suspended', () => db.exec("UPDATE account_security SET status = 'suspended' WHERE user_id = 'mia'")],
      ['the board is deleted', () => db.exec("UPDATE boards SET deleted_at = '2026-01-01'")],
    ])('writes nothing if %s after the checks', async (_name, change) => {
      competingCommit = change;
      await expect(share({ userId: 'mia', role: 'editor' })).rejects.toMatchObject({ status: 409, code: 'SHARE_CONFLICT' });
      expect(grant('mia')).toBeNull();
      expect(count('notifications')).toBe(0);
      expect(count('security_audit')).toBe(0);
    });

    it('answers a pending invitation for the same person', async () => {
      db.prepare("INSERT INTO invitations(id,token_hash,resource_type,resource_id,email,role,invited_by,created_at,expires_at) VALUES ('invitation:old','hash','board','board','mia@example.test','viewer','owner',?,?)").run(at, future);
      db.prepare("INSERT INTO notifications(id,user_id,board_id,kind,title,body,href,event_key,created_at) VALUES ('n1','mia','board','invitation','Invited','Open','/#invitation=invitation%3Aold','invitation:invitation:old:mia',?)").run(at);
      await share({ userId: 'mia', role: 'editor' });
      expect(db.prepare("SELECT revoked_at IS NOT NULL AS revoked FROM invitations WHERE id = 'invitation:old'").get()!.revoked).toBe(1);
      expect(db.prepare("SELECT read_at IS NOT NULL AS done FROM notifications WHERE id = 'n1'").get()!.done).toBe(1);
    });

    it('links workbook notifications to the workbook', async () => {
      const result = await createWorkbookInvitation(database, 'workbook', owner, { userId: 'mia', role: 'viewer' });
      expect(result).toMatchObject({ granted: true, changed: true });
      expect(grant('mia', 'workbook')).toMatchObject({ role: 'viewer', source: 'direct' });
      expect(db.prepare('SELECT board_id, href, body FROM notifications').get()).toEqual({ board_id: null, href: '/?workbook=workbook', body: 'You can now view it.' });
      expect(db.prepare('SELECT action FROM security_audit').get()!.action).toBe('workbook.shared');
    });

    it('rejects owners, invalid recipients and people who cannot share', async () => {
      await expect(share({ userId: 'mia', role: 'owner' })).rejects.toMatchObject({ status: 400 });
      await expect(share({ userId: 'owner', role: 'editor' })).rejects.toMatchObject({ status: 400 });
      await expect(share({ userId: 'sam', role: 'editor' })).rejects.toMatchObject({ status: 404, code: 'RECIPIENT_NOT_FOUND' });
      await expect(share({ userId: 'nobody', role: 'editor' })).rejects.toMatchObject({ status: 404 });
      await expect(share({ email: 'no_such_user', role: 'editor' })).rejects.toMatchObject({ status: 400 });
      await expect(share({ userId: 'mia', role: 'editor' }, native('vera'))).rejects.toMatchObject({ status: 403 });
      expect(grant('mia')).toBeNull();
    });
  });

  describe('invitation links', () => {
    it('still invites an unknown address, and an account that is not yet admitted', async () => {
      const unknown = await share({ email: 'New.Person@example.test', role: 'commenter', expiresInDays: 30 });
      expect(unknown).toMatchObject({ granted: false, email: 'new.person@example.test', role: 'commenter', status: 'pending' });
      expect(unknown.granted ? '' : unknown.token).toHaveLength(43);
      const pending = await share({ email: 'pete@example.test', role: 'viewer' });
      expect(pending.granted).toBe(false);
      expect(grant('pete')).toBeNull();
      expect(count('invitations')).toBe(2);
      expect(count('security_audit')).toBe(0);
    });

    it('re-issues a lost link for the same address and role, replacing the old one', async () => {
      const first = await share({ email: 'new@example.test', role: 'commenter' });
      if (first.granted) throw new Error('expected an invitation');
      const again = await share({ invitationId: first.id, role: 'editor', expiresInDays: 7 });
      if (again.granted) throw new Error('expected an invitation');
      expect(again).toMatchObject({ email: 'new@example.test', role: 'commenter' });
      expect(again.token).not.toBe(first.token);
      expect(db.prepare('SELECT id, revoked_at IS NOT NULL AS revoked FROM invitations ORDER BY created_at, revoked').all()).toEqual(expect.arrayContaining([{ id: first.id, revoked: 1 }, { id: again.id, revoked: 0 }]));
      await expect(share({ invitationId: 'invitation:missing', role: 'viewer' })).rejects.toMatchObject({ status: 404 });
    });
  });
});
