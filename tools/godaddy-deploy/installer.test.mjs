import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createApi, GODADDY } from './api.mjs';
import { createDeployment } from './public/flow.js';
import { providerFixture, requiredScope, release, token, passphrase } from './fixture.mjs';
const installerOrigin = 'http://127.0.0.1:5305';
function client(api) {
  return async (action, values = {}) => {
    const response = await api(new Request(`${installerOrigin}/api`, { method: 'POST', headers: { origin: installerOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, action, ...values }) }));
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status, retryAfter: body.retryAfter });
    return body;
  };
}
function setup() {
  const fixture = providerFixture(); const api = createApi({ release, fetchImpl: fixture.fetchImpl }); const call = client(api);
  const deployment = createDeployment({ call, details: { name: 'Test board', planId: 'plan-one', passphrase }, attempts: 2, sleep: async () => {} });
  return { fixture, api, call, deployment };
}
test('full deployment follows real API shapes, isolates variants, verifies package before creating an app', async () => {
  const { fixture, call, deployment } = setup();
  const plans = await call('connect'); assert.equal(plans.plans[0].available, false); assert.equal(plans.plans[1].available, true);
  assert.deepEqual(await deployment.run(), { preview: 'https://host.godaddy.com/nodejs/projects/test/preview', publish: 'https://fixture.c39.airoapp.ai' });
  assert.equal(fixture.created, 1);
  const paths = fixture.calls.map(c => c.url.replace(GODADDY, ''));
  assert.ok(paths.indexOf(release.url) < paths.indexOf('/apps?appType=NODEJS'));
  assert.ok(paths.indexOf('/apps/NODEJS-test/secrets?variant=PUBLISH') < paths.indexOf('/apps/NODEJS-test/imports'));
  assert.equal(fixture.calls.filter(c => c.url === release.url).length, 1);
});
test('response lost after create retries the same key and does not duplicate the app', async () => {
  const { fixture, deployment } = setup(); fixture.options.loseCreate = true;
  await assert.rejects(deployment.run(), /could not be reached/);
  await deployment.run(); assert.equal(fixture.created, 1);
  const creates = fixture.calls.filter(c => c.url.endsWith('/apps?appType=NODEJS'));
  assert.equal(creates.length, 2); assert.equal(creates[0].headers['Idempotency-Key'], creates[1].headers['Idempotency-Key']);
});
test('pending creation is polled; creation-time app record is followed by full addresses', async () => {
  const { fixture, deployment } = setup(); fixture.options.creationPending = true;
  await deployment.run(); assert.ok(fixture.calls.some(c => c.url.endsWith('/app-operations/op-one')));
});
test('a healthy preview cannot hide an unready live app; continue resumes only readiness check', async () => {
  const { fixture, deployment } = setup(); fixture.options.ready = false;
  await assert.rejects(deployment.run(), /not ready yet/);
  const before = fixture.calls.length; fixture.options.running = true; fixture.options.ready = true; await deployment.run();
  assert.equal(fixture.calls.length, before + 2); assert.equal(fixture.created, 1);
});
test('a healthy endpoint cannot hide a stopped published app', async () => {
  const { fixture, deployment } = setup(); fixture.options.running = false;
  await assert.rejects(deployment.run(), /not confirmed/);
  assert.equal(deployment.state.done.has('status'), false);
  assert.equal(fixture.calls.some(c => c.url.endsWith('/healthz')), false);
  const writes = fixture.calls.filter(c => ['POST', 'PUT', 'PATCH'].includes(c.method)).length;
  fixture.options.running = true;
  await deployment.run();
  assert.equal(fixture.created, 1);
  assert.equal(fixture.calls.filter(c => ['POST', 'PUT', 'PATCH'].includes(c.method)).length, writes);
});
test('missing PUBLISH status metadata still requires completed publication and live readiness', async () => {
  const { fixture, deployment } = setup(); fixture.options.omitPublishedStatus = true; fixture.options.ready = false;
  await assert.rejects(deployment.run(), /not ready yet/);
  assert.equal(deployment.state.done.has('publish'), true);
  assert.equal(deployment.state.done.has('health'), false);
  fixture.options.ready = true;
  await deployment.run();
  assert.equal(fixture.created, 1);
});
test('checksum mismatch stops before any app mutation and can be retried', async () => {
  const { fixture, deployment } = setup(); fixture.options.badChecksum = true;
  await assert.rejects(deployment.run(), /checksum/); assert.equal(fixture.created, 0);
  fixture.options.badChecksum = false; await deployment.run(); assert.equal(fixture.created, 1);
});
test('GoDaddy errors and deployment logs never expose credentials', async () => {
  const { fixture, call } = setup(); fixture.options.denied = true;
  await assert.rejects(call('connect'), e => e.status === 403 && !e.message.includes(token) && !e.message.includes(passphrase));
  fixture.options.denied = false;
  const result = await call('publish', { appId: 'NODEJS-test', key: crypto.randomUUID() });
  assert.deepEqual(Object.keys(result).sort(), ['deploymentId', 'status']);
});
test('multipart retries preserve identical bytes and idempotency key', async () => {
  const { fixture, call } = setup(); const key = crypto.randomUUID();
  await call('upload', { appId: 'NODEJS-test', key }); await call('upload', { appId: 'NODEJS-test', key });
  const uploads = fixture.calls.filter(c => c.url.endsWith('/imports'));
  assert.equal(uploads[0].headers['Content-Type'], uploads[1].headers['Content-Type']);
  assert.deepEqual(await uploads[0].body.arrayBuffer(), await uploads[1].body.arrayBuffer());
});
for (const action of ['app-operation', 'addresses', 'configure', 'upload', 'import', 'attach', 'publish', 'deployment', 'status', 'health']) {
  test(`${action}: path injection is rejected without contacting GoDaddy`, async () => {
    const { fixture, call } = setup();
    await assert.rejects(call(action, { appId: '../subscriptions', operationId: '../apps', variant: 'PREVIEW', passphrase, key: crypto.randomUUID() }));
    assert.equal(fixture.calls.filter(c => c.url.startsWith(GODADDY)).length, 0);
  });
}
for (const supplied of ['http://unsafe.test', 'https://user:password@unsafe.test', 'https://safe.test/path', 'https://safe.test?token=secret', 'javascript:alert(1)', null]) {
  test(`provider address is validated before writing settings: ${supplied}`, async () => {
    const writes = [];
    const api = createApi({ release, fetchImpl: async (url, options) => { writes.push(options.method); return Response.json({ urls: { preview: supplied } }); } });
    await assert.rejects(client(api)('configure', { appId: 'NODEJS-test', variant: 'PREVIEW', passphrase, key: crypto.randomUUID() }));
    assert.deepEqual(writes, ['GET']);
  });
}
test('cross-origin requests, wrong method and oversized bodies are rejected', async () => {
  const { api, fixture } = setup();
  const cross = await api(new Request(`${installerOrigin}/api`, { method: 'POST', headers: { origin: 'https://attacker.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'connect', token }) }));
  assert.equal(cross.status, 403);
  assert.equal((await api(new Request(`${installerOrigin}/api`))).status, 405);
  assert.equal((await api(new Request(`${installerOrigin}/api`, { method: 'POST', headers: { origin: installerOrigin, 'Content-Type': 'application/json' }, body: 'a'.repeat(12_001) }))).ok, false);
  assert.equal(fixture.calls.length, 0);
});
test('rate limit exposes a bounded retry delay, never upstream content', async () => {
  const api = createApi({ release, fetchImpl: async () => new Response(token, { status: 429, headers: { 'Retry-After': '30' } }) });
  await assert.rejects(client(api)('connect'), e => e.retryAfter === 30 && e.status === 429 && !e.message.includes(token));
});
test('failed operations stop without uploading or publishing', async () => {
  const seen = [];
  const deployment = createDeployment({ call: async action => { seen.push(action); return action === 'create' ? { operationId: 'op-one', status: 'FAILED' } : {}; }, details: { name: 'test' } });
  await assert.rejects(deployment.run(), /stopped/); assert.deepEqual(seen, ['verify-release', 'create']);
});
for (const address of ['https://127.0.0.1', 'https://169.254.169.254', 'https://app.c39.airoapp.ai.attacker.test', 'https://custom.example.com']) {
  test(`health checks cannot reach an arbitrary server: ${address}`, async () => {
    let calls = 0;
    const api = createApi({ release, fetchImpl: async () => { calls++; return Response.json({ urls: { publish: address } }); } });
    await assert.rejects(client(api)('health', { appId: 'NODEJS-test' }), /unsupported health-check/); assert.equal(calls, 1);
  });
}
test('an app briefly responding cannot bypass a pending deployment that may roll back', async () => {
  const seen = [];
  const deployment = createDeployment({ details: { name: 'New app', passphrase }, sleep: async () => {}, attempts: 2, call: async action => {
    seen.push(action);
    if (action === 'create') return { operationId: 'op-one', appId: 'NODEJS-test', status: 'COMPLETED' };
    if (action === 'upload') return { importId: 'import-one', status: 'COMPLETED' };
    if (action === 'publish' || action === 'deployment') return { deploymentId: 'deploy-one', status: 'IN_PROGRESS' };
    if (action === 'health') return { ready: true };
    return {};
  } });
  await assert.rejects(deployment.run(), /longer than usual/); assert.equal(seen.includes('health'), false);
});
test('agent instructions use the same pinned release as the installer', async () => {
  const { readFile } = await import('node:fs/promises');
  const pinned = JSON.parse(await readFile(new URL('./release.json', import.meta.url), 'utf8'));
  const prompt = await readFile(new URL('./public/agent-prompt.txt', import.meta.url), 'utf8');
  assert.ok(prompt.includes(pinned.url)); assert.ok(prompt.includes(pinned.sha256));
  assert.ok(prompt.includes('Never ask me to paste it into chat'));
});

test('an unqualified release cannot create an app or upload a package', async () => {
  const fixture = providerFixture();
  const call = client(createApi({ release: { ...release, qualified: false }, fetchImpl: fixture.fetchImpl }));
  await assert.rejects(call('verify-release'), /waiting for a release/);
  await assert.rejects(call('upload', { appId: 'NODEJS-test', key: crypto.randomUUID() }), /waiting for a release/);
  await assert.rejects(call('create', { name: 'Blocked', key: crypto.randomUUID() }), /waiting for a release/);
  assert.equal(fixture.created, 0);
});

test('release readiness is public and does not require or send a credential', async () => {
  const fixture = providerFixture(); const api = createApi({ release: { ...release, qualified: false }, fetchImpl: fixture.fetchImpl });
  const response = await api(new Request(`${installerOrigin}/api`, { method: 'POST', headers: { origin: installerOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({action:'release-status'}) }));
  assert.equal(response.status, 200); assert.equal((await response.json()).qualified, false); assert.equal(fixture.calls.length, 0);
});

const scopesIn = text => new Set(text.match(/hosting\.[a-z]+:[a-z]+/g) || []);
const setupPage = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const advertisedScopes = scopesIn(setupPage.match(/<details id="permissions">(.*?)<\/details>/s)[1]);
test('advertised setup scopes cover the full asynchronous deployment and log troubleshooting', async () => {
  const { fixture, call, deployment } = setup();
  Object.assign(fixture.options, { scopes: advertisedScopes, creationPending: true, importPending: true, publishPending: true });
  await call('connect');
  await deployment.run();
  const used = new Set(fixture.calls.filter(c => c.url.startsWith(GODADDY)).map(c => requiredScope(c.url, c.method)));
  assert.equal(used.has('hosting.source:read'), true, 'Import polling must be exercised');
  assert.equal(used.size, 8);
  assert.equal(advertisedScopes.size, 9);
  assert.equal(advertisedScopes.has('hosting.log:read'), true);
  const logs = await fixture.fetchImpl(`${GODADDY}/apps/NODEJS-test/logs?variant=PUBLISH`, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(logs.status, 200);
  const prompt = readFileSync(new URL('./public/agent-prompt.txt', import.meta.url), 'utf8');
  assert.deepEqual(scopesIn(prompt), advertisedScopes, 'Coding-agent instructions must match the setup checklist');
  assert.deepEqual(scopesIn(readFileSync(new URL('./README.md', import.meta.url), 'utf8')), advertisedScopes);
});
for (const scope of advertisedScopes) {
  test(`permission contract handles omission of ${scope}`, async () => {
    const { fixture, call, deployment } = setup();
    Object.assign(fixture.options, { scopes: new Set([...advertisedScopes].filter(s => s !== scope)), creationPending: true, importPending: true, publishPending: true });
    if (scope === 'hosting.log:read') {
      await call('connect'); await deployment.run(); // Log access is diagnostic only.
      const logs = await fixture.fetchImpl(`${GODADDY}/apps/NODEJS-test/logs?variant=PUBLISH`, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}` } });
      assert.equal(logs.status, 403);
    } else if (['hosting.source:read', 'hosting.subscription:read'].includes(scope)) {
      // The checklist explicitly lists reads; GoDaddy also allows the matching
      // write scope to satisfy them. Do not simulate a false missing-scope error.
      await call('connect'); await deployment.run();
    } else {
      await assert.rejects(async () => { await call('connect'); await deployment.run(); }, error => error.status === 403);
    }
  });
}
