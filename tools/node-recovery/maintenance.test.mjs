import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../../apps/web/node_modules/esbuild/lib/main.js';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
const send = (url, options = {}) => new Promise((resolve, reject) => {
  const req = request(url, { method: options.method || 'GET', headers: options.headers }, res => {
    const parts = []; res.on('data', b => parts.push(b));
    res.on('end', () => resolve(new Response(Buffer.concat(parts), { status: res.statusCode, headers: res.headers })));
  });
  req.on('error', reject); req.end(options.body);
});
// A raw client deliberately leaves a chunked body unfinished. Verify the
// server both delivers its rejection and closes without waiting for the body.
const rejectedUpload = (port, path, headers, expected, method = 'POST') => new Promise((resolve, reject) => {
  const socket = createConnection({ host: '127.0.0.1', port });
  let received = '';
  const timeout = setTimeout(() => { socket.destroy(); reject(new Error(`Rejected ${expected} upload kept its socket open`)); }, 2000);
  socket.on('connect', () => socket.write(`${method} ${path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}Transfer-Encoding: chunked\r\n\r\n7\r\npartial\r\n`));
  socket.on('data', chunk => { received += chunk.toString(); });
  socket.on('error', error => { clearTimeout(timeout); reject(error); });
  socket.on('close', () => {
    clearTimeout(timeout);
    try {
      assert.match(received, new RegExp(`^HTTP/1.1 ${expected} `));
      assert.match(received, /connection: close/i);
      assert(received.endsWith('\r\n\r\n'), 'Rejection response was truncated');
      resolve();
    } catch (error) { reject(error); }
  });
});

test('maintenance endpoints require the secret, canonical host and matching origin; unconfigured Preview never opens storage', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'whiteboard-recovery-http-'));
  let child;
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(r => child.once('exit', r));
    child.kill('SIGTERM'); await exited; child = null;
  }
  try {
    await symlink(resolve('apps/web/node_modules'), resolve(directory, 'node_modules'), 'dir');
    await build({ entryPoints: [resolve('tools/node-recovery/maintenance.mjs')], outfile: resolve(directory, 'server.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['mysql2/promise'], logLevel: 'silent' });
    const token = randomBytes(32).toString('hex'), key = randomBytes(32).toString('base64url');
    for (const configured of [false, true]) {
      const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
      const port = listener.address().port; await new Promise(r => listener.close(r));
      child = spawn(process.execPath, [resolve(directory, 'server.mjs')], { env: { PATH: process.env.PATH, PORT: String(port), ...(configured ? { AUTH_ORIGIN: 'https://whiteboard.example', WHITEBOARD_RECOVERY_TOKEN: token, WHITEBOARD_RECOVERY_KEY: key, WHITEBOARD_RECOVERY_MODE: 'restore' } : {}) }, stdio: 'ignore' });
      const base = 'http://127.0.0.1:' + port;
      let health;
      for (let i = 0; i < 100; i++) {
        health = await send(base + '/healthz').catch(() => null);
        if (health?.ok) break;
        assert.equal(child.exitCode, null);
        await new Promise(r => setTimeout(r, 25));
      }
      assert.equal(health?.status, 200); assert.deepEqual(await health.json(), { ready: configured, maintenance: true });
      const headers = { Host: 'whiteboard.example', Authorization: 'Bearer ' + token };
      for (const method of ['GET', 'HEAD']) {
        await rejectedUpload(port, '/healthz', { Host: 'whiteboard.example' }, 400, method);
        await rejectedUpload(port, '/recovery/status', headers, 400, method);
      }
      await rejectedUpload(port, '/recovery/restore', { ...headers, Authorization: 'Bearer wrong' }, 401);
      for (const patch of [{ Authorization: '' }, { Authorization: 'Bearer wrong' }, { Host: 'attacker.example' }, { Origin: 'https://attacker.example' }]) {
        const response = await send(base + '/recovery/restore', { method: 'POST', headers: { ...headers, ...patch }, body: 'untrusted' });
        assert.equal(response.status, 401); assert.equal(response.headers.get('access-control-allow-origin'), null);
      }
      const status = await send(base + '/recovery/status', { headers });
      assert.equal(status.status, configured ? 200 : 401);
      if (configured) {
        assert.deepEqual(await status.json(), { mode: 'restore', busy: false, complete: false });
        assert.equal((await send(base + '/recovery/restore', { headers })).status, 404);
        await rejectedUpload(port, '/wrong-path', headers, 404);
        const oversized = await send(base + '/recovery/restore', { method: 'POST', headers: { ...headers, 'Content-Length': String(129 * 1024 * 1024) } });
        assert.equal(oversized.status, 413);
        const stalled = request(base + '/recovery/restore', { method: 'POST', headers });
        const closed = new Promise(resolve => stalled.on('error', resolve));
        stalled.write('partial');
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal((await send(base + '/recovery/status', { headers }).then(r => r.json())).busy, true);
        await rejectedUpload(port, '/recovery/restore', headers, 409);
        await closed;
        assert.equal((await send(base + '/recovery/status', { headers }).then(r => r.json())).busy, false, 'Idle upload did not release the recovery slot');
        const invalid = await send(base + '/recovery/restore', { method: 'POST', headers, body: 'invalid archive' });
        assert.equal(invalid.status, 409);
        assert.equal((await invalid.text()).includes(key), false);
        assert.equal((await send(base + '/recovery/status', { headers }).then(r => r.json())).busy, false);
      }
      await stop();
    }
  } finally { await stop(); await rm(directory, { recursive: true, force: true }); }
});
