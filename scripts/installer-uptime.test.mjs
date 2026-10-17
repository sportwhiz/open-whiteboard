import test from 'node:test';
import assert from 'node:assert/strict';
import { probe, report } from './installer-uptime.mjs';

test('health retries transient errors and never sends a credential', async () => {
  let calls = 0;
  const result = await probe('https://installer.example/healthz', { pause: async () => {}, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    return Response.json({ ready: ++calls === 3 }, { status: calls === 3 ? 200 : 503 });
  } });
  assert.equal(calls, 3); assert.equal(result.healthy, true);
});

test('invalid or falsely successful health responses remain failures', async () => {
  for (const [status, body] of [[200, { ready: 'true' }], [503, { ready: true }], [200, { ready: false }]]) {
    const result = await probe('https://installer.example/healthz', { pause: async () => {}, fetchImpl: async () => Response.json(body, { status }) });
    assert.equal(result.healthy, false);
  }
  await assert.rejects(probe('https://secret@installer.example/healthz'));
});

function notifier(items = []) {
  const writes = [];
  const args = { repository: 'owner/whiteboard', recipient: 'owner', token: 'test-only', runUrl: 'https://github.com/owner/whiteboard/actions/runs/1', fetchImpl: async (url, options) => {
    assert.ok(url.startsWith('https://api.github.com/')); assert.equal(options.redirect, 'error');
    if (options.method === 'GET') return Response.json(items);
    writes.push({ url, method: options.method, body: JSON.parse(options.body) });
    return Response.json({ number: 42 });
  } };
  return { args, writes };
}
const incident = { number: 42, title: '[Monitor] GoDaddy installer outage', user: { login: 'github-actions[bot]' }, body: 'Original failure' };

test('an outage alerts the operator once and ongoing failure stays quiet', async () => {
  const first = notifier();
  assert.equal(await report({ ...first.args, result: { healthy: false, reason: 'HTTP 503' } }), 'opened');
  assert.deepEqual(first.writes[0].body.assignees, ['owner']);
  const ongoing = notifier([incident]);
  assert.equal(await report({ ...ongoing.args, result: { healthy: false } }), 'unchanged');
  assert.equal(ongoing.writes.length, 0);
});

test('recovery closes the existing alert in a single write and healthy checks stay quiet', async () => {
  const recovery = notifier([incident]);
  assert.equal(await report({ ...recovery.args, result: { healthy: true } }), 'recovered');
  assert.equal(recovery.writes.length, 1); assert.equal(recovery.writes[0].body.state, 'closed');
  assert.match(recovery.writes[0].body.body, /Original failure.*\n\n.*recovered/s);
  const healthy = notifier();
  assert.equal(await report({ ...healthy.args, result: { healthy: true } }), 'unchanged');
  assert.equal(healthy.writes.length, 0);
});

test('notification exercises cannot close or suppress real incidents', async () => {
  const fixture = notifier([incident]);
  assert.equal(await report({ ...fixture.args, exercise: true, result: { healthy: true } }), 'unchanged');
  assert.equal(await report({ ...fixture.args, exercise: true, result: { healthy: false, reason: 'Controlled outage test' } }), 'opened');
  assert.match(fixture.writes[0].body.title, /\[Monitor test\]/);
});

test('a failed notification API request fails the monitor instead of reporting delivery', async () => {
  const { args } = notifier();
  await assert.rejects(report({ ...args, result: { healthy: false }, fetchImpl: async () => new Response('', { status: 403 }) }), /HTTP 403/);
});
