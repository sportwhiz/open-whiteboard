import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_dev } from 'wrangler';

test('Workers runtime reaches the provider and health endpoint without following redirects', { timeout: 60_000 }, async t => {
  let providerRedirect = 0, healthRedirect = false, followed = 0;
  const seen = [];
  const upstream = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname.replace(/^\/v1\/hosting/, '');
    seen.push({ path, authorization: request.headers.authorization, agent: request.headers['user-agent'] });
    if (!request.headers['user-agent']) { response.writeHead(403).end(); return; }
    if (path === '/redirect-target') followed++;
    const redirect = path === '/subscriptions' ? providerRedirect : path === '/healthz' && healthRedirect ? 302 : 0;
    if (redirect) {
      response.writeHead(redirect, { Location: '/redirect-target' }).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(path === '/subscriptions'
      ? { items: [{ subscriptionId: 'test-plan', hostingProduct: 'WEB_HOSTING', status: 'ACTIVE', availableSlots: 1 }] }
      : path === '/apps/NODEJS-test'
        ? { urls: { publish: 'https://fixture.c39.airoapp.ai' } }
        : { ready: true }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-worker-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'wrangler.json');
  await writeFile(config, JSON.stringify({ name: 'whiteboard-runtime-test', compatibility_date: '2026-10-01', send_metrics: false }));
  const worker = await unstable_dev(fileURLToPath(new URL('./fixtures/worker-runtime.mjs', import.meta.url)), {
    config, local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0,
    logLevel: 'error', persist: false,
    vars: { FIXTURE_ORIGIN: `http://127.0.0.1:${upstream.address().port}` },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  });
  t.after(() => worker.stop());
  const origin = `http://${worker.address}:${worker.port}`;
  const call = async action => {
    const response = await fetch(origin + '/api', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, token: 'test-only-provider-token', appId: 'NODEJS-test' }),
    });
    return { status: response.status, body: await response.json() };
  };
  const connected = await call('connect');
  assert.equal(connected.status, 200);
  assert.equal(connected.body.plans[0]?.id, 'test-plan', JSON.stringify({ connected, seen }));
  assert.deepEqual(await call('health'), { status: 200, body: { ready: true } });
  assert.equal(seen.find(request => request.path === '/subscriptions').authorization, 'Bearer test-only-provider-token');
  assert.equal(seen.find(request => request.path === '/healthz').authorization, undefined);
  assert.ok(seen.every(request => request.agent === 'OpenWhiteboardInstaller/1.0'));
  for (const status of [301, 302, 303, 307, 308]) {
    providerRedirect = status;
    const result = await call('connect');
    assert.equal(result.status, 502);
    assert.match(result.body.error, /unexpected redirect/);
    assert.equal(JSON.stringify(result).includes('test-only-provider-token'), false);
  }
  providerRedirect = 0;
  healthRedirect = true;
  assert.deepEqual(await call('health'), { status: 200, body: { ready: false } });
  assert.equal(followed, 0, 'Neither provider nor health redirects may reach their destination');
});
