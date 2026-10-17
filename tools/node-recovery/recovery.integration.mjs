import assert from 'node:assert/strict';
import { createPool } from '../../apps/web/node_modules/mysql2/promise.js';
import { build } from '../../apps/web/node_modules/esbuild/lib/main.js';
import { mkdtemp, symlink, rm, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, createHmac } from 'node:crypto';
import { encryptArchive, decryptArchive, digest } from './archive.mjs';

assert.equal(process.env.DB_HOST, '127.0.0.1', 'Only local disposable MySQL is permitted');
const databases = ['whiteboard_recovery_source_test', 'whiteboard_recovery_target_test'];
const web = resolve('apps/web');
const temporary = await mkdtemp(resolve(tmpdir(), 'whiteboard-recovery-'));
const pool = createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD });
const setup = randomBytes(24).toString('base64url');
const password = 'Recovery ' + randomBytes(24).toString('base64url') + '!';
let source, target, recovery;
const config = async (name, label) => {
  const directory = resolve(temporary, label);
  await mkdir(directory, { mode: 0o700 });
  const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port; await new Promise(r => listener.close(r));
  return { ...process.env, DB_NAME: name, DB_TLS: 'disabled', HUDDLE_PLATFORM: 'node-private-volume', HUDDLE_DATABASE_NAMESPACE: 'live', HUDDLE_DATA_DIRECTORY: directory, ENVIRONMENT: 'test', AUTH_ORIGIN: 'http://127.0.0.1:' + port, PORT: String(port), SETUP_PASSWORD: setup, HUDDLE_MAIL_GATEWAY: 'off', HUDDLE_ASSETS_DIRECTORY: resolve(web, 'dist-node/client'), HUDDLE_MIGRATIONS_DIRECTORY: resolve(web, 'migrations') };
};
async function start(config) {
  const child = spawn(process.execPath, [resolve(web, 'dist-node/server.mjs')], { cwd: resolve(web, 'dist-node'), env: config, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = ''; child.stderr.on('data', b => { diagnostic = (diagnostic + b).slice(-3000); });
  const exited = new Promise(r => child.once('exit', r));
  const runtime = { async close() { if (child.exitCode !== null) return; child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 12000); await exited; clearTimeout(timer); } };
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Fixture runtime failed: ' + diagnostic);
      const response = await fetch(config.AUTH_ORIGIN + '/healthz').catch(() => null);
      if (response?.ok && (await response.json()).ready) return runtime;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Fixture runtime did not start');
  } catch (error) { await runtime.close(); throw error; }
}
const cookies = new Map(); let csrf = '', origin;
async function call(path, body, expected = 200, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(origin + path, { method, headers: { Origin: origin, Cookie: [...cookies].map(([k,v]) => k + '=' + v).join('; '), 'Content-Type': 'application/json', 'X-Canvas-CSRF': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const i = pair.indexOf('='); cookies.set(pair.slice(0,i), pair.slice(i+1)); }
  const data = await response.json(); assert.equal(response.status, expected, 'Unexpected response for ' + path);
  if (data.csrf) csrf = data.csrf;
  return data;
}
function totp(seed) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...seed.replaceAll('=', '')].map(c => alphabet.indexOf(c).toString(2).padStart(5,'0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b,2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
  const value = createHmac('sha1',key).update(counter).digest();
  return String((value.readUInt32BE(value[19]&15)&0x7fffffff)%1000000).padStart(6,'0');
}
try {
  for (const name of databases) { assert.match(name, /^whiteboard_recovery_\w+_test$/); await pool.query('DROP DATABASE IF EXISTS `' + name + '`'); await pool.query('CREATE DATABASE `' + name + '`'); }
  await symlink(resolve(web, 'node_modules'), resolve(temporary, 'node_modules'), 'dir');
  await build({ entryPoints: [resolve('tools/node-recovery/snapshot.mjs')], outfile: resolve(temporary, 'snapshot.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['mysql2/promise'], logLevel: 'silent' });
  const { openRecovery } = await import(pathToFileURL(resolve(temporary, 'snapshot.mjs')).href);
  const a = await config(databases[0], 'source'), b = await config(databases[1], 'target');
  source = await start(a); origin = a.AUTH_ORIGIN;
  await assert.rejects(openRecovery(a), /still running/, 'A live writer must exclude recovery');
  await call('/api/v1/auth/bootstrap'); await call('/api/v1/setup/unlock', { secret: setup });
  await call('/api/auth/setup/local', { username: 'recoveryowner', name: 'Recovery owner', password });
  await call('/api/v1/auth/bootstrap');
  const factor = await call('/api/auth/two-factor/enable', { password });
  const seed = new URL(factor.totpURI).searchParams.get('secret');
  const enrollmentCode = totp(seed);
  await call('/api/auth/two-factor/verify-totp', { code: enrollmentCode });
  await call('/api/v1/auth/bootstrap'); await call('/api/v1/setup/complete', { title: 'Recovery fixture' });
  const catalog = await call('/api/v1/catalog');
  const board = await call('/api/v1/boards', { title: 'Recover this board', workbookId: catalog.workbooks[0].id }, 201);
  const boardPath = '/api/v1/boards/' + encodeURIComponent(board.id);
  await call(boardPath + '/bootstrap');
  await call(boardPath + '/commands', { operationId: 'recovery-fixture-note', operations: [{ type: 'create_note', text: 'Retained through full recovery', color: 'yellow', x: 20, y: 20 }] });
  await call('/api/v1/admin/settings', { reauthentication_seconds: 3600 }, 200, 'PATCH');
  const before = await call(boardPath + '/semantic');
  await source.close(); source = null;
  const stoppedCatalog = new DatabaseSync(resolve(a.HUDDLE_DATA_DIRECTORY, 'live/catalog.sqlite'));
  stoppedCatalog.prepare("INSERT INTO security_outbox(id,kind,payload,expires_at,next_attempt_at,status,created_at) VALUES ('restore-mail-fixture','mail','opaque-payload',?,?,'pending',?)").run(Date.now() + 86400000, Date.now() + 3600000, Date.now());
  stoppedCatalog.close();
  // Seed a real chunked asset and opaque lease value to verify binary and
  // unsigned 64-bit round trips through mysql2 and the encrypted archive.
  await pool.query('INSERT INTO `' + databases[0] + '`.hn_live_node_blobs VALUES(?,?,?,?,?,?,?)', [Buffer.from('recovery-image'), 'fixture', 4, 'fixture', Date.now(), '{}', '{}']);
  await pool.query('INSERT INTO `' + databases[0] + '`.hn_live_node_blob_chunks VALUES(?,?,?)', [Buffer.from('recovery-image'), 0, Buffer.from([0,1,254,255])]);
  await pool.query('INSERT INTO `' + databases[0] + '`.hn_live_hl_node_leases VALUES(?,?,?,?)', ['fixture', 'holder', '18446744073709551615', 0]);
  recovery = await openRecovery(a);
  const snapshot = await recovery.exportSnapshot();
  await recovery.close(); recovery = null;
  const key = randomBytes(32).toString('base64url'); const encrypted = encryptArchive(snapshot, key); const restored = decryptArchive(encrypted,key);
  target = await start(b); await target.close(); target = null;
  recovery = await openRecovery(b, { beforeRestoreMarkerPublish() { throw new Error('Controlled marker interruption'); } });
  await assert.rejects(recovery.restoreSnapshot(restored, digest(encrypted)), /Controlled marker interruption/);
  await recovery.close(); recovery = null;
  await assert.rejects(stat(resolve(b.HUDDLE_DATA_DIRECTORY, 'live/.restore-in-progress')), { code: 'ENOENT' });
  recovery = await openRecovery(b, { afterMysqlCommit() { throw new Error('Controlled interruption'); } });
  await assert.rejects(recovery.restoreSnapshot(restored, digest(encrypted)), /Controlled interruption/);
  await recovery.close(); recovery = null;
  await assert.rejects(start(b), /interrupted restore/, 'Official runtime must refuse a half-restored installation');
  const leftover = resolve(b.HUDDLE_DATA_DIRECTORY, 'live/.restore-catalog-00000000-0000-0000-0000-000000000000');
  await writeFile(leftover, 'interrupted staging', { mode: 0o600 });
  recovery = await openRecovery(b);
  await assert.rejects(stat(leftover), { code: 'ENOENT' });
  await assert.rejects(recovery.restoreSnapshot(restored, 'a'.repeat(64)), /same interrupted restore/);
  assert.equal((await recovery.restoreSnapshot(restored, digest(encrypted))).restored, true);
  assert.equal((await recovery.restoreSnapshot(restored, digest(encrypted))).resumed, true, 'A lost success response must not repeat the restore');
  await assert.rejects(recovery.restoreSnapshot(restored, 'b'.repeat(64)), /empty installation/, 'An initialized destination cannot be overwritten');
  await recovery.close(); recovery = null;
  const restoredCatalog = new DatabaseSync(resolve(b.HUDDLE_DATA_DIRECTORY, 'live/catalog.sqlite'), { readOnly: true });
  assert.equal(restoredCatalog.prepare("SELECT status FROM security_outbox WHERE id='restore-mail-fixture'").get().status, 'suppressed');
  restoredCatalog.close();
  const [asset] = await pool.query('SELECT data FROM `' + databases[1] + '`.hn_live_node_blob_chunks WHERE asset_key=?', [Buffer.from('recovery-image')]);
  assert.deepEqual(asset[0].data, Buffer.from([0,1,254,255]));
  const [lease] = await pool.query('SELECT CAST(fence AS CHAR) AS fence FROM `' + databases[1] + '`.hn_live_hl_node_leases WHERE name=?', ['fixture']);
  assert.equal(lease[0].fence, '18446744073709551615');
  target = await start(b); origin = b.AUTH_ORIGIN;
  assert.equal((await call('/api/v1/auth/bootstrap')).setup, false);
  assert.equal((await call('/api/v1/admin/settings')).settings.reauthentication_seconds,3600);
  assert.deepEqual(await call(boardPath + '/semantic'), before);
  await call('/api/v1/setup/unlock', { secret: setup }, 409);
  cookies.clear(); csrf = '';
  await call('/api/v1/auth/bootstrap');
  const login = await call('/api/auth/sign-in/local', { username: 'recoveryowner', password });
  assert.equal(login.success, true);
  await call(boardPath + '/semantic', undefined, 403);
  // MFA deliberately rejects reuse of the enrollment code within its time step.
  while (totp(seed) === enrollmentCode) await new Promise(r => setTimeout(r, 500));
  await call('/api/auth/two-factor/verify-totp', { code: totp(seed) });
  await call('/api/v1/auth/bootstrap');
  assert.deepEqual(await call(boardPath + '/semantic'), before);
  await target.close(); target = null;
  recovery = await openRecovery(b);
  await assert.rejects(recovery.restoreSnapshot(restored, digest(encrypted)), /empty installation/, 'A replay after normal app use must not report a successful restore');
  await recovery.close(); recovery = null;
  console.log('PASS full SQLite/MySQL encrypted recovery, owner/MFA/session/key continuity, board/settings/asset data, live-writer exclusion, interrupted-restore retry, and populated-target refusal.');
} finally {
  await recovery?.close(); await source?.close(); await target?.close();
  for (const name of databases) await pool.query('DROP DATABASE IF EXISTS `' + name + '`');
  await pool.end(); await rm(temporary, { recursive: true, force: true });
}
