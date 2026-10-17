// Test-only provider simulator. Production entry points never import this module.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GODADDY } from './api.mjs';
export const token = 'test-only-godaddy-token';
export const passphrase = 'test-only-setup-passphrase';
export const bytes = new TextEncoder().encode('PK fixture release bytes');
export const release = { qualified: true, version: '0.4.0', url: 'https://github.com/sportwhiz/open-whiteboard/releases/download/v0.4.0/open-whiteboard-node.zip', sha256: createHash('sha256').update(bytes).digest('hex') };
// Test contract from GoDaddy's Hosting scopes reference. Unknown endpoints fail
// closed so new installer calls require an explicit permission review.
export function requiredScope(url, method = 'GET') {
  const path = new URL(url).pathname.replace('/v1/hosting', '');
  const routes = [
    ['GET', /^\/subscriptions$/, 'hosting.subscription:read'],
    ['POST', /^\/apps$/, 'hosting.application:create'],
    ['GET', /^\/app-operations\/[^/]+$/, 'hosting.application:read'],
    ['GET', /^\/apps\/[^/]+(?:\/status|\/deployments\/[^/]+)?$/, 'hosting.application:read'],
    ['PATCH', /^\/apps\/[^/]+\/secrets$/, 'hosting.secret:write'],
    ['PUT', /^\/apps\/[^/]+\/subscription$/, 'hosting.subscription:write'],
    ['POST', /^\/apps\/[^/]+\/imports$/, 'hosting.source:write'],
    ['GET', /^\/apps\/[^/]+\/imports\/[^/]+$/, 'hosting.source:read'],
    ['POST', /^\/apps\/[^/]+\/deployments$/, 'hosting.deployment:execute'],
    ['GET', /^\/apps\/[^/]+\/logs$/, 'hosting.log:read'],
  ];
  const route = routes.find(([verb, pattern]) => verb === method && pattern.test(path));
  assert.ok(route, `Permission review needed: ${method} ${path}`);
  return route[2];
}
export function providerFixture() {
  const calls = []; const keys = new Map();
  const options = { loseCreate: false, noPlans: false, running: true, ready: true, badChecksum: false, creationPending: false, denied: false };
  let created = 0;
  const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
  async function fetchImpl(url, init = {}) {
    calls.push({ url, ...init });
    if (url === 'https://fixture.c39.airoapp.ai/healthz') { assert.equal(init.headers.Authorization, undefined); return response({ ready: options.ready }); }
    if (url === release.url) { assert.equal(init.headers?.Authorization, undefined); return new Response(options.badChecksum ? 'bad bytes' : bytes); }
    assert.ok(url.startsWith(`${GODADDY}/`)); assert.equal(init.redirect, 'error');
    if (init.headers.Authorization !== `Bearer ${token}`) return response({ error: 'secret provider message' }, 401);
    if (options.denied) return response({ error: `${token} ${passphrase}` }, 403);
    const path = url.slice(GODADDY.length); const method = init.method;
    const scope = requiredScope(url, method);
    // GoDaddy documents write as satisfying reads for the same resource.
    const inherited = scope.endsWith(':read') && options.scopes?.has(scope.replace(':read', ':write'));
    if (options.scopes && !options.scopes.has(scope) && !inherited) return response({ error: 'Missing scope' }, 403);
    if (path.startsWith('/subscriptions?')) return response({ items: options.noPlans ? [] : [
      { subscriptionId: 'plan-full', label: 'Full plan', hostingProduct: 'WEB_HOSTING', status: 'ACTIVE', availableSlots: 0 },
      { subscriptionId: 'plan-one', label: 'My hosting plan', hostingProduct: 'WEB_HOSTING', status: 'ACTIVE', availableSlots: 2 },
    ] });
    if (path === '/apps?appType=NODEJS') {
      const key = init.headers['Idempotency-Key'];
      if (!keys.has(key)) { created++; keys.set(key, { operationId: 'op-one', status: options.creationPending ? 'PENDING' : 'COMPLETED', app: { id: 'NODEJS-test' } }); }
      if (options.loseCreate) { options.loseCreate = false; throw new Error('Response lost after creation'); }
      return response(keys.get(key), 202);
    }
    if (path === '/app-operations/op-one') return response({ operationId: 'op-one', status: 'COMPLETED', app: { id: 'NODEJS-test' } });
    if (path === '/apps/NODEJS-test') return response({ urls: { preview: 'https://host.godaddy.com/nodejs/projects/test/preview', publish: 'https://fixture.c39.airoapp.ai' } });
    if (path.startsWith('/apps/NODEJS-test/secrets?')) {
      if (options.rejectConfigureOnce) { options.rejectConfigureOnce = false; return response({ error: 'Expired token' }, 401); }
      assert.equal(method, 'PATCH'); assert.equal(init.headers['Content-Type'], 'application/json-patch+json');
      const settings = Object.fromEntries(JSON.parse(init.body).map(v => { assert.equal(v.op, 'add'); return [v.path, v.value]; }));
      const preview = path.endsWith('PREVIEW');
      assert.deepEqual(settings, { ...(!preview ? { '/AUTH_ORIGIN': 'https://fixture.c39.airoapp.ai' } : {}), '/SETUP_PASSWORD': passphrase, '/HUDDLE_PLATFORM': 'godaddy', '/GODADDY_APP_ID': 'NODEJS-test', '/GODADDY_VARIANT': preview ? 'PREVIEW' : 'PUBLISH', '/HUDDLE_DATABASE_NAMESPACE': preview ? 'preview' : 'live' });
      return response({ secrets: [] });
    }
    if (path === '/apps/NODEJS-test/subscription') { assert.equal(method, 'PUT'); assert.equal(JSON.parse(init.body).subscriptionId, 'plan-one'); return response({}); }
    if (path === '/apps/NODEJS-test/imports') {
      const form = await new Response(init.body, { headers: { 'Content-Type': init.headers['Content-Type'] } }).formData();
      assert.equal(form.get('file').name, 'open-whiteboard-node.zip');
      assert.deepEqual(new Uint8Array(await form.get('file').arrayBuffer()), bytes);
      return response({ importId: 'import-one', status: options.importPending ? 'PENDING' : 'COMPLETED' }, 202);
    }
    if (path === '/apps/NODEJS-test/imports/import-one') return response({ importId: 'import-one', status: 'COMPLETED' });
    if (path === '/apps/NODEJS-test/deployments') { assert.equal(method, 'POST'); assert.deepEqual(JSON.parse(init.body), {}); return response({ deploymentId: 'deploy-one', status: options.publishPending ? 'PENDING' : 'COMPLETED', logs: [token, passphrase] }, 202); }
    if (path === '/apps/NODEJS-test/deployments/deploy-one') return response({ deploymentId: 'deploy-one', status: 'COMPLETED' });
    if (path.startsWith('/apps/NODEJS-test/logs?')) return response({ items: [] });
    if (path === '/apps/NODEJS-test/status') return response({ status: 'ACTIVE', variants: [{ variant: 'PREVIEW', status: 'RUNNING' }, ...(options.omitPublishedStatus ? [] : [{ variant: 'PUBLISH', status: options.running ? 'RUNNING' : 'STOPPED' }])] });
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  }
  return { fetchImpl, calls, options, get created() { return created; } };
}
