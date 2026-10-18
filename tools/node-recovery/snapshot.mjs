import { createPool } from 'mysql2/promise';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, realpath, stat, lstat, rename, unlink, open, readdir } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { constants } from 'node:fs';
import { buildMysqlPoolOptions } from '../../apps/web/src/node/database.ts';
import { namespaceMysqlPool, validateDatabaseNamespace, logicalDatabaseTable } from '../../apps/web/src/node/database-namespace.ts';
import { digest, encodeCell, decodeCell, MAX_PLAIN } from './archive.mjs';

// Only the SQLite-catalog backend is supported. No arbitrary SQL or table names
// from an uploaded archive are executed. Schema comes from the installed app.
const tables = ['hl_node_migrations', 'hl_node_secrets', 'hl_node_leases', 'node_room_values', 'node_room_alarms', 'node_blobs', 'node_blob_chunks'];
const quote = name => {
  if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name)) throw new Error('Invalid database identifier.');
  return '`' + name + '`';
};
function sqliteSchema(db) {
  return digest(JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all()));
}
function checkSqlite(db) {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Catalog integrity check failed.');
}
export async function openRecovery(config, { afterMysqlCommit, beforeRestoreMarkerPublish } = {}) {
  if (!['godaddy', 'node-private-volume'].includes(config.HUDDLE_PLATFORM ?? 'godaddy')) throw new Error('Recovery requires the private SQLite catalog backend.');
  if (config.AUTH_SECRET || config.AUTH_SECRETS || config.AUTH_ENCRYPTION_KEYS) throw new Error('External authentication keys require a separate backup; this tool supports managed installation keys.');
  const namespace = validateDatabaseNamespace(config.HUDDLE_DATABASE_NAMESPACE);
  const base = resolve(config.HUDDLE_DATA_DIRECTORY || '/private/huddle-loom');
  const directory = await realpath(resolve(base, namespace));
  const catalogPath = resolve(directory, 'catalog.sqlite');
  if ((await lstat(catalogPath)).isSymbolicLink() || (await stat(catalogPath)).mode & 0o077) throw new Error('Catalog must be a private regular file.');
  const pool = namespaceMysqlPool(createPool({ ...buildMysqlPoolOptions(config), dateStrings: true, bigNumberStrings: true }), namespace);
  let connection;
  try { connection = await pool.getConnection(); }
  catch (error) { await pool.end(); throw error; }
  let locked = false;
  let lock, directoryHandle;
  try {
    directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if ((await directoryHandle.stat()).mode & 0o077) throw new Error('Recovery directory must be private.');
    const [rows] = await connection.query('SELECT DATABASE() AS db');
    lock = 'huddle-rooms:' + createHash('sha256').update(rows[0].db).digest('hex').slice(0, 48);
    const [owned] = await connection.execute('SELECT GET_LOCK(?,0) AS acquired', [lock]);
    if (Number(owned[0]?.acquired) !== 1) throw new Error('The application is still running. Recovery requires exclusive ownership.');
    locked = true;
    // No live app or recovery process can own these files while we hold the
    // database lock. Never remove a marker or follow a directory/symlink.
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && /^\.(?:snapshot|restore-catalog|restore-marker|restore-completed)-[a-f0-9-]{36}$/.test(entry.name))
        await unlink(resolve(directory, entry.name));
    }
    const [inventory] = await connection.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    const logical = logicalDatabaseTable(namespace);
    const names = inventory.map(row => logical(row.name)).filter(Boolean);
    if (tables.some(name => !names.includes(name)) || names.some(name => !tables.includes(name) && (namespace || /^(?:hl_|node_|installation$)/.test(name)))) throw new Error('Unexpected or incomplete installation schema.');
    const metadata = [];
    for (const name of tables) {
      const [definition] = await connection.query('SHOW CREATE TABLE ' + quote(name));
      const [columns] = await connection.query('SHOW COLUMNS FROM ' + quote(name));
      metadata.push({ name, schema: digest(definition[0]['Create Table']), columns: columns.map(c => c.Field), primary: columns.filter(c => c.Key === 'PRI').map(c => c.Field) });
    }
    const sqlite = new DatabaseSync(catalogPath, { readOnly: true, allowExtension: false });
    let schema;
    try { checkSqlite(sqlite); schema = sqliteSchema(sqlite); } finally { sqlite.close(); }
    const assertOwner = async () => {
      const [rows] = await connection.execute('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned', [lock]);
      if (Number(rows[0]?.owned) !== 1) throw new Error('Recovery lost database ownership.');
    };
    return {
      async close() {
        try { if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [lock]); }
        finally { connection.destroy(); try { await pool.end(); } finally { await directoryHandle?.close(); } }
      },
      async exportSnapshot() {
        await assertOwner();
        try { await stat(resolve(directory, '.restore-in-progress')); throw new Error('Finish the interrupted restore before taking a backup.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const temporary = resolve(directory, '.snapshot-' + randomUUID());
        let bytes;
        const sqlite = new DatabaseSync(catalogPath, { readOnly: true, allowExtension: false });
        try {
          sqlite.exec("VACUUM INTO '" + temporary.replaceAll("'", "''") + "'");
          const snapshotFile = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            await snapshotFile.chmod(0o600);
            const info = await snapshotFile.stat();
            if (!info.isFile() || info.size > MAX_PLAIN / 2) throw new Error('Catalog exceeds the recovery size limit.');
            bytes = await snapshotFile.readFile();
          } finally { await snapshotFile.close(); }
        } finally { sqlite.close(); await unlink(temporary).catch(() => {}); }
        const snapshot = { format: 'open-whiteboard/installation-recovery', version: 1, namespace, catalogDirectory: directory, createdAt: new Date().toISOString(), sqliteSchema: schema, sqlite: bytes.toString('base64'), tables: [] };
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        let totalBytes = snapshot.sqlite.length;
        try {
          for (const table of metadata) {
            const rows = [];
            // The app is stopped and the namespace ownership lock is held, so
            // bounded pages cannot race with insertions or deletions.
            for (let offset = 0; ; offset += 100) {
              const [page] = await connection.query('SELECT * FROM ' + quote(table.name) + ' ORDER BY ' + table.primary.map(quote).join(',') + ' LIMIT 100 OFFSET ' + offset);
              for (const row of page) {
                const encoded = table.columns.map(name => encodeCell(row[name]));
                totalBytes += Buffer.byteLength(JSON.stringify(encoded));
                if (totalBytes > MAX_PLAIN - 1024 * 1024) throw new Error('Installation exceeds the recovery size limit.');
                rows.push(encoded);
              }
              if (page.length < 100) break;
            }
            snapshot.tables.push({ ...table, rows });
          }
          await assertOwner();
          await connection.commit();
          return snapshot;
        } catch (error) { await connection.rollback(); throw error; }
      },
      async restoreSnapshot(snapshot, archiveDigest) {
        await assertOwner();
        if (!/^[a-f0-9]{64}$/.test(archiveDigest) || snapshot?.format !== 'open-whiteboard/installation-recovery' || snapshot.version !== 1 || snapshot.namespace !== namespace || typeof snapshot.catalogDirectory !== 'string' || !isAbsolute(snapshot.catalogDirectory) || snapshot.sqliteSchema !== schema || !Array.isArray(snapshot.tables) || snapshot.tables.length !== metadata.length || typeof snapshot.sqlite !== 'string') throw new Error('Archive is incompatible with this empty installation.');
        const decoded = snapshot.tables.map((table, index) => {
          const expected = metadata[index];
          if (table.name !== expected.name || table.schema !== expected.schema || JSON.stringify(table.columns) !== JSON.stringify(expected.columns) || !Array.isArray(table.rows)) throw new Error('Archive database schema mismatch.');
          return { ...expected, rows: table.rows.map(row => {
            if (!Array.isArray(row) || row.length !== expected.columns.length) throw new Error('Invalid archive row.');
            return row.map(decodeCell);
          }) };
        });
        const secrets = decoded.find(t => t.name === 'hl_node_secrets');
        const location = secrets.rows.find(row => row[secrets.columns.indexOf('name')] === 'catalog-location-v1');
        const valueIndex = secrets.columns.indexOf('value');
        const expectedLocation = createHash('sha256').update('sqlite:' + snapshot.catalogDirectory).digest();
        if (!location || !Buffer.isBuffer(location[valueIndex]) || !location[valueIndex].equals(expectedLocation)) throw new Error('Archived catalog location identity is invalid.');
        // A deliberate restore may move the private directory. Authentication
        // and encryption keys are preserved; only the location guard is rebound.
        location[valueIndex] = createHash('sha256').update('sqlite:' + directory).digest();
        const markerPath = resolve(directory, '.restore-in-progress');
        const completedPath = resolve(directory, '.restore-completed');
        let marker;
        try { marker = JSON.parse(await readFile(markerPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (marker && marker.digest !== archiveDigest) throw new Error('Resume the same interrupted restore.');
        let completed;
        try { completed = JSON.parse(await readFile(completedPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (completed?.digest === archiveDigest) {
          if (marker) await unlink(markerPath);
          return { restored: true, alreadyCompleted: true, resumed: true, tables: decoded.length };
        }
        if (!marker) {
          const sqlite = new DatabaseSync(catalogPath, { readOnly: true, allowExtension: false });
          try {
            if (sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n || sqlite.prepare('SELECT COUNT(*) AS n FROM boards').get().n || sqlite.prepare("SELECT 1 FROM installation WHERE state='ready'").get()) throw new Error('Restore requires an empty installation with no users or boards.');
          } finally { sqlite.close(); }
          for (const name of ['node_room_values', 'node_blobs', 'node_blob_chunks']) {
            const [rows] = await connection.query('SELECT 1 FROM ' + quote(name) + ' LIMIT 1');
            if (rows.length) throw new Error('Restore destination already contains data.');
          }
        }
        const bytes = Buffer.from(snapshot.sqlite, 'base64');
        if (bytes.toString('base64') !== snapshot.sqlite || !bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw new Error('Invalid catalog snapshot.');
        const staged = resolve(directory, '.restore-catalog-' + randomUUID());
        try {
          await writeFile(staged, bytes, { mode: 0o600, flag: 'wx', flush: true });
          const sqlite = new DatabaseSync(staged, { readOnly: true, allowExtension: false });
          try { checkSqlite(sqlite); if (sqliteSchema(sqlite) !== schema) throw new Error('Catalog schema mismatch.'); } finally { sqlite.close(); }
          // A clone must never deploy back into the original app using a saved
          // provider token. Reconnect updates explicitly after verifying recovery.
          const restored = new DatabaseSync(staged, { allowExtension: false });
          try {
            restored.exec("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE; UPDATE software_update_settings SET automatic_security=0,hook_ciphertext=NULL WHERE id='instance'; UPDATE software_updates SET status='uncertain',message='Restored from backup. Verify the hosting deployment before continuing.' WHERE status IN ('queued','building','deploying','verifying'); UPDATE security_outbox SET status='suppressed',lease_key=NULL,lease_until=NULL,last_error='Restored from backup; resend if still needed.' WHERE kind='mail' AND status IN ('pending','processing'); COMMIT;");
          } finally { restored.close(); }
          const stagedHandle = await open(staged, 'r'); try { await stagedHandle.sync(); } finally { await stagedHandle.close(); }
          if (!marker) {
            const markerTemporary = resolve(directory, '.restore-marker-' + randomUUID());
            try {
              await writeFile(markerTemporary, JSON.stringify({ digest: archiveDigest }), { flag: 'wx', mode: 0o600, flush: true });
              await beforeRestoreMarkerPublish?.();
              await rename(markerTemporary, markerPath);
              await directoryHandle.sync();
            } finally { await unlink(markerTemporary).catch(() => {}); }
          }
          // Keep the old catalog self-contained before removing its WAL files.
          // An interruption before the final rename must still leave a catalog
          // that can be opened to resume the same restore.
          const oldCatalog = new DatabaseSync(catalogPath, { allowExtension: false });
          try {
            if (oldCatalog.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') throw new Error('Could not checkpoint the destination catalog.');
          } finally { oldCatalog.close(); }
          await connection.beginTransaction();
          try {
            for (const table of [...decoded].reverse()) await connection.query('DELETE FROM ' + quote(table.name));
            for (const table of decoded) {
              const insert = 'INSERT INTO ' + quote(table.name) + ' (' + table.columns.map(quote).join(',') + ') VALUES (' + table.columns.map(() => '?').join(',') + ')';
              for (const row of table.rows) await connection.execute(insert, row);
            }
            await assertOwner();
            await connection.commit();
          } catch (error) { await connection.rollback().catch(() => {}); throw error; }
          await afterMysqlCommit?.();
          // Keep the marker until both stores are restored. A failed/ambiguous
          // commit may only be retried with the identical authenticated archive.
          for (const suffix of ['-wal', '-shm']) await unlink(catalogPath + suffix).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await rename(staged, catalogPath);
          await directoryHandle.sync();
          const completedTemporary = resolve(directory, '.restore-completed-' + randomUUID());
          try {
            await writeFile(completedTemporary, JSON.stringify({ digest: archiveDigest }), { flag: 'wx', mode: 0o600, flush: true });
            await rename(completedTemporary, completedPath);
            await directoryHandle.sync();
          } finally { await unlink(completedTemporary).catch(() => {}); }
          await unlink(markerPath);
          await directoryHandle.sync();
          return { restored: true, tables: decoded.length };
        } finally { await unlink(staged).catch(() => {}); }
      },
    };
  } catch (error) {
    try { if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [lock]); } finally { connection.destroy(); try { await pool.end(); } finally { await directoryHandle?.close(); } }
    throw error;
  }
}
