// Temporary operator-only recovery package. It replaces the application while
// taking/restoring a snapshot, so normal writers cannot race the two databases.
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { encryptArchive, decryptArchive, recoveryKey, digest, MAX_ARCHIVE } from './archive.mjs';
import { openRecovery } from './snapshot.mjs';

process.umask(0o077);
const token = process.env.WHITEBOARD_RECOVERY_TOKEN;
const key = process.env.WHITEBOARD_RECOVERY_KEY;
const mode = process.env.WHITEBOARD_RECOVERY_MODE;
let configured = false, origin;
try {
  origin = new URL(process.env.AUTH_ORIGIN);
  configured = /^[a-f0-9]{64}$/.test(token || '') && ['backup', 'restore'].includes(mode) && origin.protocol === 'https:' && origin.origin === process.env.AUTH_ORIGIN;
  recoveryKey(key);
} catch { configured = false; }
const tokenHash = createHash('sha256').update('Bearer ' + token).digest();
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
let busy = false, complete = false, archive;
function rejectRequest(request, response, status) {
  // Flush the HTTP status, then close even if the sender never finishes its
  // body. Draining rejected uploads would retain the 30-minute body deadline.
  response.once('finish', () => request.destroy());
  response.writeHead(status, { Connection: 'close' }).end();
}
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  // Read-only endpoints never accept uploads. Otherwise an unauthenticated
  // health probe could leave a body unfinished after receiving its response.
  if (['GET', 'HEAD'].includes(request.method) && (request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) > 0)) {
    rejectRequest(request, response, 400); return;
  }
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
  const validHost = configured && request.headers.host?.toLowerCase() === origin.host.toLowerCase();
  // GoDaddy starts Preview after an import, before Publish secrets apply. Keep
  // its supervisor probe healthy without opening storage or enabling recovery.
  if ((!configured || validHost || loopback) && ['/', '/healthz'].includes(request.url) && ['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Content-Type', 'application/json');
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ ready: configured, maintenance: true })); return;
  }
  const supplied = createHash('sha256').update(request.headers.authorization || '').digest();
  if (!configured || !validHost || !timingSafeEqual(supplied, tokenHash) || (request.headers.origin && request.headers.origin !== origin.origin)) { rejectRequest(request, response, 401); return; }
  if (request.method === 'GET' && request.url === '/recovery/status') {
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ mode, busy, complete })); return;
  }
  if (request.method !== 'POST' || request.url !== '/recovery/' + mode) { rejectRequest(request, response, 404); return; }
  if (busy) { rejectRequest(request, response, 409); return; }
  if (Number(request.headers['content-length'] || 0) > MAX_ARCHIVE) {
    rejectRequest(request, response, 413); return;
  }
  busy = true;
  let recovery;
  try {
    if (mode === 'backup' && archive) {
      response.setHeader('Content-Type', 'application/octet-stream'); response.end(archive); return;
    }
    let bytes;
    if (mode === 'restore') {
      // Large transfers may take minutes, but a stalled sender cannot hold
      // the only recovery slot indefinitely. Clear this before database work.
      request.setTimeout(30_000, () => request.destroy());
      const chunks = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > MAX_ARCHIVE) throw new Error('Archive is too large.');
        chunks.push(chunk);
      }
      request.setTimeout(0);
      bytes = Buffer.concat(chunks);
    } else {
      request.resume();
    }
    const snapshot = mode === 'restore' ? decryptArchive(bytes, key) : null;
    recovery = await openRecovery(process.env);
    if (mode === 'backup') {
      archive = encryptArchive(await recovery.exportSnapshot(), key);
      complete = true;
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Disposition', 'attachment; filename="installation.owbackup"');
      response.end(archive);
    } else {
      const result = await recovery.restoreSnapshot(snapshot, digest(bytes)); complete = true;
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
    }
  } catch {
    // Never log database values, provider credentials, keys, or raw exceptions.
    response.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Recovery did not complete. Keep this maintenance package installed and inspect the private operator record before retrying.' }));
  } finally {
    try { await recovery?.close(); } catch { complete = false; }
    busy = false;
  }
});
// A 128 MiB archive can take many minutes on a slow uplink. Authentication is
// checked before reading its body; retain a separate short header deadline.
server.requestTimeout = 30 * 60_000;
server.headersTimeout = 15_000;
server.listen(port, '0.0.0.0', () => console.log('Open Whiteboard recovery maintenance is ready.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close();
  const deadline = setTimeout(() => process.exit(1), 15_000); deadline.unref();
});
