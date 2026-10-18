import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPool } from 'mysql2/promise';
import { SqliteCatalog } from './sqlite-catalog';
import { MysqlCatalog } from './mysql-catalog';
import { migrateCatalogSchema } from './catalog-schema';
import { logicalDatabaseTable, namespaceMysqlPool } from './database-namespace';
import {
  createBoard, createFolder, createWorkbook, deleteFolder, deleteWorkbook, listTrash, readCatalog,
  updateFolder, restoreFolder, restoreBoard, restoreWorkbook, trashBoard, updateBoard,
} from '../catalog.server';
import type { Principal } from '../collaboration-types';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const principal = (id: string, extra: Partial<Principal> = {}): Principal => ({ id, email: `${id}@test.invalid`, name: id, avatarUrl: null, color: '#000000', issuer: 'test', subject: id, sessionId: 'test', expiresAt: null, authentication: 'local-development', ...extra });

type Backend = 'sqlite' | 'mysql';
const mysqlUrl = process.env.CATALOG_MYSQL_TEST_URL;

/** The same catalog SQL runs on D1/SQLite and on MySQL for the Node package. */
async function open(backend: Backend) {
  if (backend === 'mysql') {
    const url = new URL(mysqlUrl!);
    if (!url.pathname.endsWith('_test')) throw new Error('Use a disposable *_test MySQL database');
    // A fresh table namespace per test keeps fixed ids from colliding between tests.
    const namespace = `t${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const pool = namespaceMysqlPool(createPool(url.toString()), namespace);
    await migrateCatalogSchema(pool);
    const catalog = new MysqlCatalog(pool, undefined, logicalDatabaseTable(namespace));
    await catalog.initializeMetadata();
    return { database: { close: () => void pool.end() }, db: catalog as unknown as D1Database };
  }
  const directory = await mkdtemp(resolve(tmpdir(), 'whiteboard-trash-'));
  directories.push(directory);
  const database = await SqliteCatalog.open(resolve(directory, 'catalog.sqlite'));
  await database.migrate(resolve('migrations'));
  return { database, db: database as unknown as D1Database };
}

async function setup(backend: Backend) {
  const { database, db } = await open(backend);
  for (const id of ['owner', 'editor', 'stranger', 'other']) {
    await db.prepare('INSERT INTO users(id,issuer,subject,email,display_name,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .bind(id, 'test', id, `${id}@test.invalid`, id, '#000000', '2026-10-18', '2026-10-18').run();
  }
  const grant = (type: 'board' | 'workbook', resource: string, user: string, role: string) => db.prepare('INSERT INTO resource_grants(resource_type,resource_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .bind(type, resource, user, role, '2026-10-18', '2026-10-18').run();
  return { database, db, grant };
}

// Each MySQL test builds a fresh catalog schema, which is slow on shared CI runners.
const TEST_TIMEOUT = 60_000;

function suite(backend: Backend) {
  describe(`trash and restore (${backend})`, { timeout: TEST_TIMEOUT }, () => {
    it('lets the board owner trash, list and restore a board without changing its edit time', async () => {
      const { database, db, grant } = await setup(backend);
      try {
        const owner = principal('owner');
        const book = await createWorkbook(db, { title: 'Plans' }, owner);
        await grant('workbook', book.id, 'owner', 'owner');
        await grant('workbook', book.id, 'editor', 'editor');
        const board = await createBoard(db, { title: 'Roadmap', workbookId: book.id }, owner);
        await updateBoard(db, board.id, { title: 'Roadmap 2026' });
        const edited = await db.prepare('SELECT updated_at AS updatedAt FROM boards WHERE id = ?').bind(board.id).first<{ updatedAt: string }>();
        expect(edited?.updatedAt).toBe(board.updatedAt);
        await trashBoard(db, board.id);
        const trash = await listTrash(db, owner);
        expect(trash.boards.map(item => [item.title, item.workbookTitle])).toEqual([['Roadmap 2026', 'Plans']]);
        expect((await listTrash(db, principal('editor'))).boards).toEqual([]);
        await expect(restoreBoard(db, board.id, {}, principal('editor'))).rejects.toMatchObject({ status: 403 });
        await expect(restoreBoard(db, board.id, {}, principal('stranger'))).rejects.toMatchObject({ status: 404 });
        await expect(restoreBoard(db, board.id, {}, principal('owner', { resourceMode: 'selected', resources: [] }))).rejects.toMatchObject({ status: 404 });
        expect(await restoreBoard(db, board.id, {}, principal('owner', { resourceMode: 'selected', resources: [{ type: 'workbook', id: book.id }] }))).toMatchObject({ workbookId: book.id, moved: false });
        const restored = await db.prepare('SELECT deleted_at AS deletedAt, updated_at AS updatedAt FROM boards WHERE id = ?').bind(board.id).first();
        expect(restored).toEqual({ deletedAt: null, updatedAt: board.updatedAt });
        await expect(restoreBoard(db, board.id, {}, owner)).rejects.toMatchObject({ status: 404 });
      } finally { database.close(); }
    });

    it('deletes a workbook with its boards and restores exactly those boards', async () => {
      const { database, db, grant } = await setup(backend);
      try {
        const owner = principal('owner');
        const book = await createWorkbook(db, { title: 'Offsite' }, owner);
        const other = await createWorkbook(db, { title: 'Elsewhere' }, owner);
        for (const id of [book.id, other.id]) await grant('workbook', id, 'owner', 'owner');
        await grant('workbook', book.id, 'editor', 'editor');
        const kept = await createBoard(db, { title: 'Agenda', workbookId: book.id }, owner);
        const earlier = await createBoard(db, { title: 'Old draft', workbookId: book.id }, owner);
        await trashBoard(db, earlier.id);
        await new Promise(resolve => setTimeout(resolve, 5));
        await expect(deleteWorkbook(db, book.id, principal('editor'))).rejects.toMatchObject({ status: 403 });
        expect(await deleteWorkbook(db, book.id, owner)).toMatchObject({ boards: 1 });
        expect((await readCatalog(db)).boards.some(item => item.id === kept.id)).toBe(false);
        const trash = await listTrash(db, owner);
        expect(trash.workbooks.map(item => [item.title, item.boardCount])).toEqual([['Offsite', 1]]);
        expect(trash.boards.map(item => item.title)).toEqual(['Old draft']);
        // A board trashed on its own earlier needs a new home while its workbook is in the trash.
        await expect(restoreBoard(db, earlier.id, {}, owner)).rejects.toMatchObject({ status: 409 });
        await expect(restoreWorkbook(db, book.id, principal('editor'))).rejects.toMatchObject({ status: 403 });
        await expect(restoreWorkbook(db, book.id, principal('stranger'))).rejects.toMatchObject({ status: 404 });
        expect(await restoreWorkbook(db, book.id, owner)).toMatchObject({ boards: 1 });
        const catalog = await readCatalog(db);
        expect(catalog.boards.some(item => item.id === kept.id)).toBe(true);
        expect(catalog.boards.some(item => item.id === earlier.id)).toBe(false);
        expect(await restoreBoard(db, earlier.id, { workbookId: other.id }, owner)).toMatchObject({ workbookId: other.id, moved: true });
        await expect(restoreBoard(db, kept.id, { workbookId: '' }, owner)).rejects.toMatchObject({ status: 400 });
      } finally { database.close(); }
    });

    it('never trashes someone else’s private board with a workbook', async () => {
      const { database, db, grant } = await setup(backend);
      try {
        const owner = principal('owner');
        const book = await createWorkbook(db, { title: 'Team' }, owner);
        await grant('workbook', book.id, 'owner', 'owner');
        const secret = await createBoard(db, { title: 'Private notes', workbookId: book.id, private: true }, principal('other'));
        await grant('board', secret.id, 'other', 'owner');
        await expect(deleteWorkbook(db, book.id, owner)).rejects.toMatchObject({ status: 409 });
        expect((await readCatalog(db)).workbooks.some(item => item.id === book.id)).toBe(true);
      } finally { database.close(); }
    });
  });

  describe(`folders (${backend})`, { timeout: TEST_TIMEOUT }, () => {
    it('renames and deletes only your own folders; deleting unfiles workbooks and keeps everything else', async () => {
      const { database, db, grant } = await setup(backend);
      try {
        const owner = principal('owner');
        const folder = await createFolder(db, { title: 'Work' }, owner);
        const theirs = await createFolder(db, { title: 'Theirs' }, principal('other'));
        const book = await createWorkbook(db, { title: 'Filed', folderId: folder.id }, owner);
        await grant('workbook', book.id, 'owner', 'owner');
        const board = await createBoard(db, { title: 'Inside', workbookId: book.id }, owner);
        expect(await updateFolder(db, folder.id, { title: '  Projects ' }, owner)).toEqual({ updated: true, id: folder.id, title: 'Projects' });
        for (const body of [null, {}, { title: '' }, { title: 'x'.repeat(121) }]) await expect(updateFolder(db, folder.id, body, owner)).rejects.toMatchObject({ status: 400 });
        await expect(updateFolder(db, theirs.id, { title: 'Mine now' }, owner)).rejects.toMatchObject({ status: 404 });
        await expect(deleteFolder(db, theirs.id, owner)).rejects.toMatchObject({ status: 404 });
        await expect(deleteFolder(db, folder.id, owner_selected())).rejects.toMatchObject({ status: 404 });
        await expect(updateFolder(db, folder.id, { title: 'x' }, owner_selected())).rejects.toMatchObject({ status: 404 });
        expect(await deleteFolder(db, folder.id, owner)).toEqual({ deleted: true, id: folder.id, unfiled: 1, workbookIds: [book.id], folderIds: [] });
        const catalog = await readCatalog(db);
        expect(catalog.folders.some(item => item.id === folder.id)).toBe(false);
        expect(catalog.workbooks.find(item => item.id === book.id)).toMatchObject({ folderId: null });
        expect(catalog.boards.some(item => item.id === board.id)).toBe(true);
        await expect(deleteFolder(db, folder.id, owner)).rejects.toMatchObject({ status: 404 });
      } finally { database.close(); }
      function owner_selected() { return principal('owner', { resourceMode: 'selected', resources: [] }); }
    });
  });

  describe(`invitation notifications (${backend})`, { timeout: TEST_TIMEOUT }, () => {
    it('are marked read once the invitation is accepted', async () => {
      const { database, db } = await setup(backend);
      try {
        const { readAcceptedInvitationNotifications } = await import('../catalog.server');
        await db.prepare("INSERT INTO invitations(id,token_hash,resource_type,resource_id,email,role,invited_by,created_at,expires_at,accepted_at,accepted_by) VALUES('inv1','hash1','workbook','workbook:a','editor@test.invalid','editor','owner','2026-10-18','2099-01-01','2026-10-18','editor')").run();
        for (const [id, key] of [['n1', 'invitation:inv1:editor'], ['n2', 'invitation:inv2:editor']]) {
          await db.prepare("INSERT INTO notifications(id,user_id,kind,title,body,event_key,created_at) VALUES(?, 'editor', 'invitation', 'Invited', 'Open', ?, '2026-10-18')").bind(id, key).run();
        }
        await readAcceptedInvitationNotifications(db, principal('editor'), 'workbook', 'workbook:a');
        const rows = (await db.prepare("SELECT id, read_at IS NOT NULL AS isRead FROM notifications ORDER BY id").all()).results;
        expect(rows).toEqual([{ id: 'n1', isRead: 1 }, { id: 'n2', isRead: 0 }]);
      } finally { database.close(); }
    });
  });

  describe(`review hardening (${backend})`, { timeout: TEST_TIMEOUT }, () => {
    it('never restores into a trashed workbook, even its own, and grants before moving', async () => {
      const { database, db, grant } = await setup(backend);
      try {
        const owner = principal('owner');
        const book = await createWorkbook(db, { title: 'Gone' }, owner);
        const other = await createWorkbook(db, { title: 'Here' }, owner);
        for (const id of [book.id, other.id]) await grant('workbook', id, 'owner', 'owner');
        const board = await createBoard(db, { title: 'Draft', workbookId: book.id }, owner);
        await trashBoard(db, board.id);
        await new Promise(resolve => setTimeout(resolve, 5));
        await deleteWorkbook(db, book.id, owner);
        await expect(restoreBoard(db, board.id, { workbookId: book.id }, owner)).rejects.toMatchObject({ status: 404 });
        await expect(restoreBoard(db, board.id, {}, owner)).rejects.toMatchObject({ status: 409 });
        const order: string[] = [];
        await restoreBoard(db, board.id, { workbookId: other.id }, owner, async () => {
          const row = await db.prepare('SELECT deleted_at AS deletedAt, workbook_id AS workbookId FROM boards WHERE id = ?').bind(board.id).first<{ deletedAt: string | null; workbookId: string }>();
          order.push(row?.deletedAt ? `granted while trashed in ${row.workbookId === book.id ? 'old' : 'new'}` : 'too late');
        });
        expect(order).toEqual(['granted while trashed in old']);
      } finally { database.close(); }
    });

    it('shows a trashed board’s workbook only to people with a grant on that workbook', async () => {
      const { database, db, grant } = await setup(backend);
      try {
        const owner = principal('owner');
        const book = await createWorkbook(db, { title: 'Secret plans' }, owner);
        await grant('workbook', book.id, 'owner', 'owner');
        const board = await createBoard(db, { title: 'Shared board', workbookId: book.id }, owner);
        await grant('board', board.id, 'editor', 'owner');
        await trashBoard(db, board.id);
        const [listed] = (await listTrash(db, principal('editor'))).boards;
        expect(listed).toMatchObject({ id: board.id, workbookTitle: null, workbookDeletedAt: null });
        expect((await listTrash(db, owner)).boards[0]).toMatchObject({ workbookTitle: 'Secret plans' });
      } finally { database.close(); }
    });

    it('lists only owned boards before applying its limit', async () => {
      const { database, db, grant } = await setup(backend);
      try {
        const owner = principal('owner');
        const theirs = await createWorkbook(db, { title: 'Theirs' }, principal('other'));
        await grant('workbook', theirs.id, 'other', 'owner');
        await grant('workbook', theirs.id, 'owner', 'viewer');
        for (let index = 0; index < 510; index++) {
          await db.prepare("INSERT INTO boards(id,workbook_id,title,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?)")
            .bind(`board:noise-${index}`, theirs.id, `Noise ${index}`, '2026-10-18', '2026-10-18', `2026-10-19T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`).run();
        }
        const mine = await createWorkbook(db, { title: 'Mine' }, owner);
        await grant('workbook', mine.id, 'owner', 'owner');
        const board = await createBoard(db, { title: 'Mine trashed', workbookId: mine.id }, owner);
        await db.prepare('UPDATE boards SET deleted_at = ? WHERE id = ?').bind('2026-10-01T00:00:00.000Z', board.id).run();
        expect((await listTrash(db, owner)).boards.map(item => item.id)).toEqual([board.id]);
      } finally { database.close(); }
    });

    it('ignores an expired ownership grant when protecting private boards', async () => {
      const { database, db, grant } = await setup(backend);
      try {
        const owner = principal('owner');
        const book = await createWorkbook(db, { title: 'Team' }, owner);
        await grant('workbook', book.id, 'owner', 'owner');
        const secret = await createBoard(db, { title: 'Private', workbookId: book.id, private: true }, owner);
        await db.prepare("INSERT INTO resource_grants(resource_type,resource_id,user_id,role,created_at,updated_at,expires_at) VALUES('board',?,?,?,?,?,?)")
          .bind(secret.id, 'owner', 'owner', '2026-10-18', '2026-10-18', '2000-01-01T00:00:00.000Z').run();
        await expect(deleteWorkbook(db, book.id, owner)).rejects.toMatchObject({ status: 409 });
        expect((await readCatalog(db)).boards.some(item => item.id === secret.id)).toBe(true);
      } finally { database.close(); }
    });

    it('moves folders without cycles and deleting a folder lifts its subfolders to the top level', async () => {
      const { database, db } = await setup(backend);
      try {
        const owner = principal('owner');
        const parent = await createFolder(db, { title: 'Parent' }, owner);
        const child = await createFolder(db, { title: 'Child' }, owner);
        expect(await updateFolder(db, child.id, { parentId: parent.id }, owner)).toMatchObject({ updated: true });
        await expect(updateFolder(db, parent.id, { parentId: child.id }, owner)).rejects.toMatchObject({ status: 400 });
        await deleteFolder(db, parent.id, owner);
        expect(await db.prepare('SELECT parent_id AS parentId, deleted_at AS deletedAt FROM folders WHERE id = ?').bind(child.id).first()).toEqual({ parentId: null, deletedAt: null });
      } finally { database.close(); }
    });
  });
}

suite('sqlite');
if (mysqlUrl) suite('mysql');

describe('folder undo', () => {
  it('restores a deleted folder and re-files only its own still-unfiled workbooks and subfolders', async () => {
    const { database, db, grant } = await setup();
    try {
      const owner = principal('owner');
      const folder = await createFolder(db, { title: 'Work' }, owner);
      const child = await createFolder(db, { title: 'Child', parentId: folder.id }, owner);
      const mine = await createWorkbook(db, { title: 'Mine', folderId: folder.id }, owner);
      const moved = await createWorkbook(db, { title: 'Moved since', folderId: folder.id }, owner);
      const elsewhere = await createFolder(db, { title: 'Elsewhere' }, owner);
      const notMine = await createWorkbook(db, { title: 'Not mine' }, principal('other'));
      for (const id of [mine.id, moved.id]) await grant('workbook', id, 'owner', 'owner');
      await grant('workbook', notMine.id, 'other', 'owner');
      const deleted = await deleteFolder(db, folder.id, owner);
      expect(deleted).toMatchObject({ workbookIds: expect.arrayContaining([mine.id, moved.id]), folderIds: [child.id] });
      await db.prepare('UPDATE workbooks SET folder_id = ? WHERE id = ?').bind(elsewhere.id, moved.id).run();
      await expect(restoreFolder(db, folder.id, deleted, principal('other'))).rejects.toMatchObject({ status: 404 });
      await expect(restoreFolder(db, folder.id, { workbookIds: 'x' }, owner)).rejects.toMatchObject({ status: 400 });
      await expect(restoreFolder(db, folder.id, deleted, principal('owner', { resourceMode: 'selected', resources: [] }))).rejects.toMatchObject({ status: 404 });
      expect(await restoreFolder(db, folder.id, { ...deleted, workbookIds: [...deleted.workbookIds, notMine.id] }, owner)).toEqual({ restored: true, id: folder.id, refiled: 1 });
      const catalog = await readCatalog(db);
      expect(catalog.folders.some(item => item.id === folder.id)).toBe(true);
      expect(catalog.workbooks.find(item => item.id === mine.id)?.folderId).toBe(folder.id);
      expect(catalog.workbooks.find(item => item.id === moved.id)?.folderId).toBe(elsewhere.id);
      expect(catalog.workbooks.find(item => item.id === notMine.id)?.folderId).toBe(null);
      expect(catalog.folders.find(item => item.id === child.id)?.parentId).toBe(folder.id);
      await expect(restoreFolder(db, folder.id, deleted, owner)).rejects.toMatchObject({ status: 404 });
    } finally { database.close(); }
  });
});


describe.each<Backend>(mysqlUrl ? ['sqlite', 'mysql'] : ['sqlite'])('folder recovery (%s)', backend => {
  it('does not restore a child around its own ancestor after folders move', async () => {
    const { database, db } = await setup(backend);
    try {
      const owner = principal('owner');
      const a = await createFolder(db, { title: 'A' }, owner);
      const b = await createFolder(db, { title: 'B', parentId: a.id }, owner);
      const c = await createFolder(db, { title: 'C', parentId: b.id }, owner);
      const deleted = await deleteFolder(db, b.id, owner);
      await updateFolder(db, a.id, { parentId: c.id }, owner);
      await restoreFolder(db, b.id, deleted, owner);
      const folders = (await readCatalog(db)).folders;
      expect(folders.find(f => f.id === c.id)?.parentId).toBe(null);
      expect(folders.find(f => f.id === b.id)?.parentId).toBe(a.id);
    } finally { database.close(); }
  });

  it('rolls back the entire restore after a database failure and permits retry', async () => {
    const { database, db } = await setup(backend);
    try {
      const owner = principal('owner');
      const parent = await createFolder(db, { title: 'Parent' }, owner);
      const child = await createFolder(db, { title: 'Child', parentId: parent.id }, owner);
      const deleted = await deleteFolder(db, parent.id, owner);
      const faulty = new Proxy(db, { get(target, property) {
        if (property === 'batch') return (statements: D1PreparedStatement[]) => target.batch([
          ...statements.slice(0, -1), target.prepare('SELECT * FROM deliberately_missing_review_table'), statements.at(-1)!,
        ]);
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await expect(restoreFolder(faulty, parent.id, deleted, owner)).rejects.toThrow();
      expect((await db.prepare('SELECT deleted_at AS deletedAt FROM folders WHERE id = ?').bind(parent.id).first())!.deletedAt).not.toBe(null);
      expect((await db.prepare('SELECT parent_id AS parentId FROM folders WHERE id = ?').bind(child.id).first())!.parentId).toBe(null);
      await expect(restoreFolder(db, parent.id, deleted, owner)).resolves.toMatchObject({ restored: true });
      expect((await db.prepare('SELECT parent_id AS parentId FROM folders WHERE id = ?').bind(child.id).first())!.parentId).toBe(parent.id);
    } finally { database.close(); }
  });

  it('captures every workbook moved by deletion even when another tab files one', async () => {
    const { database, db, grant } = await setup(backend);
    try {
      const owner = principal('owner');
      const folder = await createFolder(db, { title: 'Folder' }, owner);
      const first = await createWorkbook(db, { title: 'First', folderId: folder.id }, owner);
      const late = await createWorkbook(db, { title: 'Filed by another tab' }, owner);
      await grant('workbook', first.id, owner.id, 'owner');
      await grant('workbook', late.id, owner.id, 'owner');
      let interleaved = false;
      const racing = new Proxy(db, { get(target, property) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          // Another request may run between transactions, but never inside one.
          const folderStillActive = await target.prepare('SELECT id FROM folders WHERE id = ? AND deleted_at IS NULL').bind(folder.id).first();
          if (folderStillActive && !interleaved) {
            interleaved = true;
            await target.prepare('UPDATE workbooks SET folder_id = ? WHERE id = ?').bind(folder.id, late.id).run();
          }
          return results;
        };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const deleted = await deleteFolder(racing, folder.id, owner);
      expect(deleted.workbookIds).toContain(first.id);
      if (interleaved) expect(deleted.workbookIds).toContain(late.id);
      await restoreFolder(db, folder.id, deleted, owner);
      expect((await readCatalog(db)).workbooks.find(book => book.id === first.id)?.folderId).toBe(folder.id);
    } finally { database.close(); }
  });

  it('restores at the top level when its former parent was also deleted', async () => {
    const { database, db } = await setup(backend);
    try {
      const owner = principal('owner');
      const parent = await createFolder(db, { title: 'Parent' }, owner);
      const child = await createFolder(db, { title: 'Child', parentId: parent.id }, owner);
      const deleted = await deleteFolder(db, child.id, owner);
      await deleteFolder(db, parent.id, owner);
      await restoreFolder(db, child.id, deleted, owner);
      expect((await db.prepare('SELECT parent_id AS parentId FROM folders WHERE id = ?').bind(child.id).first())!.parentId).toBe(null);
    } finally { database.close(); }
  });
});
