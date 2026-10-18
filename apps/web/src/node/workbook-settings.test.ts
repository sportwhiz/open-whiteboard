import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteCatalog } from './sqlite-catalog';
import { createFolder, createWorkbook, optionalJsonObject, updateWorkbook } from '../catalog.server';
import type { Principal } from '../collaboration-types';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const principal = (id: string): Principal => ({ id, email: `${id}@test.invalid`, name: id, avatarUrl: null, color: '#000000', issuer: 'test', subject: id, sessionId: 'test', expiresAt: null, authentication: 'local-development' });

describe('workbook organization', () => {
  it('renames and files a workbook without changing grants; rejects other owners’ folders and non-owners', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'whiteboard-workbook-'));
    directories.push(directory);
    const database = await SqliteCatalog.open(resolve(directory, 'catalog.sqlite'));
    try {
      await database.migrate(resolve('migrations'));
      const db = database as unknown as D1Database;
      for (const id of ['owner', 'editor', 'viewer', 'stranger']) {
        await db.prepare('INSERT INTO users(id,issuer,subject,email,display_name,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
          .bind(id, 'test', id, `${id}@test.invalid`, id, '#000000', '2026-10-18', '2026-10-18').run();
      }
      const owner = principal('owner');
      const folder = await createFolder(db, { title: 'Projects' }, owner);
      const otherFolder = await createFolder(db, { title: 'Private folder' }, principal('stranger'));
      const book = await createWorkbook(db, { title: 'Before' }, owner);
      for (const role of ['owner', 'editor', 'viewer']) {
        await db.prepare("INSERT INTO resource_grants(resource_type,resource_id,user_id,role,created_at,updated_at) VALUES('workbook',?,?,?,?,?)")
          .bind(book.id, role, role, '2026-10-18', '2026-10-18').run();
      }
      const grants = (await db.prepare('SELECT * FROM resource_grants ORDER BY user_id').all()).results;
      expect(await updateWorkbook(db, book.id, { title: '  Planning  ', folderId: folder.id }, owner)).toEqual({ id: book.id, title: 'Planning', folderId: folder.id });
      expect((await db.prepare('SELECT * FROM resource_grants ORDER BY user_id').all()).results).toEqual(grants);
      for (const id of ['editor', 'viewer', 'stranger']) {
        await expect(updateWorkbook(db, book.id, { title: 'Denied', folderId: null }, principal(id))).rejects.toThrow();
      }
      await expect(updateWorkbook(db, book.id, { title: 'Denied', folderId: otherFolder.id }, owner)).rejects.toThrow('Folder not found');
      await expect(updateWorkbook(db, book.id, { title: 'Denied', folderId: folder.id }, { ...owner, resourceMode: 'selected', resources: [] })).rejects.toThrow('Workbook not found');
      for (const body of [null, [], {}, { title: '', folderId: null }, { title: 3 }, { title: 'x'.repeat(121), folderId: null }, { title: 'X', folderId: 3 }, { title: 'X', folderId: '' }, { folderId: '  ' }]) {
        await expect(updateWorkbook(db, book.id, body, owner)).rejects.toMatchObject({ status: 400 });
      }
      expect(await updateWorkbook(db, book.id, { title: 'Planning', folderId: null }, owner)).toMatchObject({ folderId: null });
      expect(await db.prepare('SELECT title, folder_id FROM workbooks WHERE id = ?').bind(book.id).first()).toEqual({ title: 'Planning', folder_id: null });
      await db.prepare('UPDATE workbooks SET deleted_at = ? WHERE id = ?').bind('2026-10-18', book.id).run();
      await expect(updateWorkbook(db, book.id, { title: 'Deleted', folderId: null }, owner)).rejects.toThrow('Workbook not found');
    } finally { database.close(); }
  });

  it('keeps another owner’s filing when a co-owner renames, and only moves when asked', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'whiteboard-workbook-'));
    directories.push(directory);
    const database = await SqliteCatalog.open(resolve(directory, 'catalog.sqlite'));
    try {
      await database.migrate(resolve('migrations'));
      const db = database as unknown as D1Database;
      for (const id of ['alice', 'bob']) {
        await db.prepare('INSERT INTO users(id,issuer,subject,email,display_name,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
          .bind(id, 'test', id, `${id}@test.invalid`, id, '#000000', '2026-10-18', '2026-10-18').run();
      }
      const alice = principal('alice');
      const bob = principal('bob');
      const alicesFolder = await createFolder(db, { title: 'Alice projects' }, alice);
      const bobsFolder = await createFolder(db, { title: 'Bob projects' }, bob);
      const book = await createWorkbook(db, { title: 'Shared plan', folderId: alicesFolder.id }, alice);
      for (const id of ['alice', 'bob']) {
        await db.prepare("INSERT INTO resource_grants(resource_type,resource_id,user_id,role,created_at,updated_at) VALUES('workbook',?,?,'owner',?,?)")
          .bind(book.id, id, '2026-10-18', '2026-10-18').run();
      }
      const filing = () => db.prepare('SELECT title, folder_id AS folderId FROM workbooks WHERE id = ?').bind(book.id).first();

      // Bob cannot see Alice's folder; renaming without a folderId leaves it filed there.
      expect(await updateWorkbook(db, book.id, { title: 'Shared roadmap' }, bob)).toEqual({ id: book.id, title: 'Shared roadmap', folderId: null });
      expect(await filing()).toEqual({ title: 'Shared roadmap', folderId: alicesFolder.id });
      // Alice still sees her folder in the response.
      expect(await updateWorkbook(db, book.id, { title: 'Shared roadmap 2' }, alice)).toEqual({ id: book.id, title: 'Shared roadmap 2', folderId: alicesFolder.id });
      // Moving is explicit: a folder-only change keeps the name.
      expect(await updateWorkbook(db, book.id, { folderId: bobsFolder.id }, bob)).toEqual({ id: book.id, title: 'Shared roadmap 2', folderId: bobsFolder.id });
      expect(await filing()).toEqual({ title: 'Shared roadmap 2', folderId: bobsFolder.id });
      expect(await updateWorkbook(db, book.id, { folderId: null }, bob)).toMatchObject({ folderId: null });
      expect(await filing()).toEqual({ title: 'Shared roadmap 2', folderId: null });
    } finally { database.close(); }
  });
});

describe('optional JSON actions', () => {
  const request = (body?: string) => new Request('https://studio.test/api/v1/boards/x/duplicate', { method: 'POST', body, headers: body === undefined ? {} : { 'content-type': 'application/json' } });
  it('treats an empty body as no options and still rejects malformed input', async () => {
    expect(await optionalJsonObject(request())).toEqual({});
    expect(await optionalJsonObject(request(''))).toEqual({});
    expect(await optionalJsonObject(request('  '))).toEqual({});
    expect(await optionalJsonObject(request('{"title":"Copy"}'))).toEqual({ title: 'Copy' });
    for (const body of ['[]', 'null', '"text"', '{', '3']) {
      await expect(optionalJsonObject(request(body))).rejects.toMatchObject({ status: 400 });
    }
    await expect(optionalJsonObject(request(JSON.stringify({ title: 'x'.repeat(200) })), 50)).rejects.toMatchObject({ status: 413 });
  });
});

describe('filing visibility', () => {
  it('flags only workbooks filed in a folder the viewer cannot see', async () => {
    const { markFiledElsewhere } = await import('../catalog.server');
    const raw = { folders: [], boards: [], workbooks: [{ id: 'a', folderId: 'theirs', title: 'A' }, { id: 'b', folderId: 'mine', title: 'B' }, { id: 'c', folderId: null, title: 'C' }] };
    const visible = { folders: [], boards: [], workbooks: [{ id: 'a', folderId: null, title: 'A' }, { id: 'b', folderId: 'mine', title: 'B' }, { id: 'c', folderId: null, title: 'C' }, { id: 'workbook:shared', folderId: null, title: 'Shared boards' }] };
    expect(markFiledElsewhere(raw, visible).workbooks.map(workbook => [workbook.id, workbook.filedElsewhere])).toEqual([['a', true], ['b', false], ['c', false], ['workbook:shared', false]]);
  });
});
