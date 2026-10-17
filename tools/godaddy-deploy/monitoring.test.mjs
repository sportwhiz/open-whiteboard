import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createMonitor, reportingCredentialKey } from './monitoring.mjs';
import { createApi } from './api.mjs';
import { release, providerFixture, token, passphrase } from './fixture.mjs';

function setup(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  for (const file of readdirSync(new URL('./migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL('./migrations/' + file, import.meta.url), 'utf8'));
  function prepare(query, args = []) {
    return {
      bind: (...values) => prepare(query, values),
      first: async () => sql.prepare(query).get(...args) ?? null,
      all: async () => ({ results: sql.prepare(query).all(...args) }),
      run: async () => ({ meta: sql.prepare(query).run(...args) }),
    };
  }
  const mail = [];
  let time = Date.now();
  const env = {
    INSTALLER_ALERTS: { prepare, batch: async statements => { sql.exec('BEGIN'); try { const rows = []; for (const s of statements) rows.push(await s.run()); sql.exec('COMMIT'); return rows; } catch (e) { sql.exec('ROLLBACK'); throw e; } } },
    EMAIL: { send: async message => { mail.push(message); return { messageId: 'test-only' }; } },
    ALERT_TO: 'operator@example.test', ALERT_FROM: 'installer@example.test', ALERT_DELIVERY_VERIFIED: 'true',
  };
  const monitor = createMonitor(env, release.version, () => time);
  const incident = { attempt: crypto.randomUUID(), action: 'publish', category: 'operation_failed' };
  sql.prepare('INSERT INTO installer_attempts (attempt, updated) VALUES (?, ?)').run(incident.attempt, time);
  return { sql, env, monitor, incident, mail, advance: milliseconds => { time += milliseconds; } };
}
const minutes = n => n * 60_000;
test('monitor requires verified delivery, a live scheduler, and healthy delivery state', async t => {
  const { monitor, env, advance } = setup(t);
  assert.equal(await monitor.ready(), false);
  await monitor.tick(); assert.equal(await monitor.ready(), true);
  env.ALERT_DELIVERY_VERIFIED = 'false'; assert.equal(await monitor.ready(), false);
  env.ALERT_DELIVERY_VERIFIED = 'true'; advance(minutes(16)); assert.equal(await monitor.ready(), false);
});
test('diagnostic allowlist rejects arbitrary strings and stores no extra fields', async t => {
  const { monitor, sql, incident } = setup(t);
  for (const item of [{ ...incident, attempt: token }, { ...incident, action: passphrase }, { ...incident, category: token }]) assert.equal(await monitor.record(item), false);
  assert.equal(await monitor.record({ ...incident, token, passphrase, appId: 'private-app', error: token }), true);
  const stored = JSON.stringify(sql.prepare('SELECT * FROM installer_incidents').all());
  for (const secret of [token, passphrase, 'private-app']) assert.equal(stored.includes(secret), false);
});
test('repeated failures produce one delayed digest and stable support reference', async t => {
  const { monitor, incident, advance, mail, sql } = setup(t);
  await monitor.record(incident); await monitor.record(incident); await monitor.tick(); assert.equal(mail.length, 0);
  advance(minutes(6)); await Promise.all([monitor.tick(), monitor.tick()]);
  assert.equal(mail.length, 1); assert.ok(mail[0].text.includes(incident.attempt));
  assert.equal(sql.prepare('SELECT reported FROM installer_incidents').get().reported, 1);
  advance(minutes(65)); await monitor.record(incident); await monitor.tick(); assert.equal(mail.length, 1);
});
test('successful retries before the digest suppress the alert', async t => {
  const { monitor, incident, advance, mail } = setup(t);
  await monitor.record(incident); await monitor.resolve(incident.attempt, incident.action);
  advance(minutes(6)); await monitor.tick(); assert.equal(mail.length, 0);
});
test('failed mail stays pending, blocks new installs, and retries', async t => {
  const { monitor, env, incident, advance, mail, sql } = setup(t);
  const send = env.EMAIL.send;
  env.EMAIL.send = async () => { throw new Error('Private provider error'); };
  await monitor.record(incident); advance(minutes(6)); await monitor.tick();
  assert.equal(await monitor.ready(), false);
  assert.equal(sql.prepare('SELECT reported FROM installer_incidents').get().reported, 0);
  env.EMAIL.send = send; advance(minutes(6)); await monitor.tick();
  assert.equal(mail.length, 1); assert.equal(await monitor.ready(), true);
});
test('mail recovery reopens installation even when all original incidents have resolved', async t => {
  const { monitor, env, incident, advance, mail } = setup(t);
  const send = env.EMAIL.send;
  let attempts = 0;
  env.EMAIL.send = async () => { attempts++; throw new Error('Temporary mail outage'); };
  await monitor.record(incident); advance(minutes(6)); await monitor.tick();
  await monitor.resolve(incident.attempt, incident.action);
  advance(minutes(6)); await monitor.tick();
  assert.equal(attempts, 2, 'An empty incident queue must not prevent delivery recovery');
  assert.equal(await monitor.ready(), false);
  env.EMAIL.send = send; advance(minutes(6));
  await Promise.all([monitor.tick(), monitor.tick()]);
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /email check/);
  assert(!mail[0].text.includes(incident.attempt), 'Resolved incidents must not be sent as failures');
  assert.equal(await monitor.ready(), true);
  advance(minutes(65)); await monitor.tick();
  assert.equal(mail.length, 1, 'Successful recovery must not send recurring probes');
});
test('new incidents respect the hourly email limit and retention', async t => {
  const { monitor, incident, advance, mail, sql } = setup(t);
  await monitor.record(incident); advance(minutes(6)); await monitor.tick();
  const another = crypto.randomUUID(); await monitor.authorize(another, "a".repeat(64));
  await monitor.record({ ...incident, attempt: another });
  advance(minutes(6)); await monitor.tick(); assert.equal(mail.length, 1);
  advance(minutes(60)); await monitor.tick(); assert.equal(mail.length, 2);
  advance(minutes(31 * 24 * 60)); await monitor.tick();
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM installer_incidents').get().n, 0);
});
function request(api, action, attempt, values = {}) {
  return api(new Request('https://installer.test/api', { method: 'POST', headers: { origin: 'https://installer.test', 'content-type': 'application/json' }, body: JSON.stringify({ action, attempt, token, ...values }) }));
}
test('API records sanitized provider failure and resolves it after a successful retry', async t => {
  const { monitor, sql, incident } = setup(t); await monitor.tick();
  const fixture = providerFixture(); fixture.options.denied = true;
  const api = createApi({ release, monitor, fetchImpl: fixture.fetchImpl });
  const failed = await request(api, 'connect', incident.attempt);
  assert.equal(failed.status, 403); assert.equal((await failed.json()).supportReference, incident.attempt);
  const row = sql.prepare('SELECT * FROM installer_incidents').get(); assert.equal(row.category, 'access_denied');
  assert.equal(JSON.stringify(row).includes(token), false);
  fixture.options.denied = false; assert.equal((await request(api, 'connect', incident.attempt)).status, 200);
  assert.equal(sql.prepare('SELECT resolved FROM installer_incidents').get().resolved, 1);
});
test('failed asynchronous job is recorded even when GoDaddy returns HTTP 200', async t => {
  const { monitor, incident, sql } = setup(t); await monitor.tick();
  const api = createApi({ release, monitor, fetchImpl: async () => Response.json({ deploymentId: 'deploy-test', status: 'FAILED', error: token }) });
  const response = await request(api, 'deployment', incident.attempt, { appId: 'NODEJS-test', deploymentId: 'deploy-test' });
  assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.supportReference, incident.attempt); assert.equal(body.error, undefined);
  assert.equal(sql.prepare('SELECT category FROM installer_incidents').get().category, 'operation_failed');
});
test('monitor outage blocks new apps but preserves in-progress read/recovery access', async t => {
  const { monitor, env, incident } = setup(t);
  const fixture = providerFixture(); const api = createApi({ release, monitor, fetchImpl: fixture.fetchImpl });
  assert.equal((await request(api, 'create', incident.attempt, { name: 'test', key: crypto.randomUUID() })).status, 503);
  assert.equal(fixture.created, 0);
  assert.equal((await request(api, 'addresses', incident.attempt, { appId: 'NODEJS-test' })).status, 200);
  env.INSTALLER_ALERTS.prepare = () => { throw new Error('Database down'); };
  assert.equal(await monitor.ready(), false);
});
test('hosted deployments cannot omit the anonymous reporting reference', async t => {
  const { monitor } = setup(t); await monitor.tick();
  const fixture = providerFixture(); const api = createApi({ release, monitor, fetchImpl: fixture.fetchImpl });
  const response = await request(api, 'create', undefined, { name: 'test', key: crypto.randomUUID() });
  assert.equal(response.status, 400); assert.equal(fixture.created, 0);
});
test('browser timeout reports require valid metadata and are labeled separately', async t => {
  const { monitor, incident, sql } = setup(t); await monitor.tick();
  const api = createApi({ release, monitor });
  const response = await request(api, 'report-stalled', incident.attempt, { stage: 'health', token: '' });
  assert.equal((await response.json()).supportReference, incident.attempt);
  assert.equal(sql.prepare('SELECT category FROM installer_incidents').get().category, 'browser_timeout');
  assert.equal((await (await request(api, 'report-stalled', incident.attempt, { stage: token })).json()).reported, false);
});
test('report storage failure never masks the original provider error or successful mutation', async t => {
  const { monitor, env, incident } = setup(t); await monitor.tick();
  const fixture = providerFixture(); const api = createApi({ release, monitor, fetchImpl: fixture.fetchImpl });
  env.INSTALLER_ALERTS.prepare = () => { throw new Error('Private database failure'); };
  const result = await request(api, 'attach', incident.attempt, { appId: 'NODEJS-test', planId: 'plan-one' });
  assert.equal(result.status, 200);
  fixture.options.denied = true;
  const failed = await request(api, 'addresses', incident.attempt, { appId: 'NODEJS-test' });
  assert.equal(failed.status, 403); assert.equal((await failed.json()).supportReference, undefined);
});
test('pending jobs and unhealthy responses do not resolve an incident prematurely', async t => {
  const { monitor, incident, sql } = setup(t); await monitor.tick();
  await monitor.record({ ...incident, action: 'health', category: 'browser_timeout' });
  const fixture = providerFixture(); fixture.options.ready = false;
  const api = createApi({ release, monitor, fetchImpl: fixture.fetchImpl });
  await request(api, 'health', incident.attempt, { appId: 'NODEJS-test' });
  assert.equal(sql.prepare('SELECT resolved FROM installer_incidents').get().resolved, 0);
  fixture.options.ready = true;
  await request(api, 'health', incident.attempt, { appId: 'NODEJS-test' });
  assert.equal(sql.prepare('SELECT resolved FROM installer_incidents').get().resolved, 1);
  await monitor.record({ ...incident, action: 'upload', category: 'browser_timeout' });
  fixture.options.importPending = true;
  await request(api, 'upload', incident.attempt, { appId: 'NODEJS-test', key: crypto.randomUUID() });
  assert.equal(sql.prepare("SELECT resolved FROM installer_incidents WHERE action = 'upload'").get().resolved, 0);
  await request(api, 'import', incident.attempt, { appId: 'NODEJS-test', importId: 'import-one' });
  assert.equal(sql.prepare("SELECT resolved FROM installer_incidents WHERE action = 'upload'").get().resolved, 1);
});

test('a resolved failure that happens again gets a new grace period and alert', async t => {
  const { monitor, incident, advance, mail } = setup(t);
  await monitor.record(incident); advance(minutes(6)); await monitor.tick();
  await monitor.resolve(incident.attempt, incident.action);
  advance(minutes(65)); await monitor.record(incident); await monitor.tick();
  assert.equal(mail.length, 1);
  advance(minutes(6)); await monitor.tick(); assert.equal(mail.length, 2);
});
test('unknown timeouts cannot populate reports and rejected tokens use bounded aggregate counters', async t => {
  const { monitor, sql, advance, mail } = setup(t); await monitor.tick();
  const api = createApi({ release, monitor, fetchImpl: async () => new Response('', { status: 401 }) });
  for (let i = 0; i < 100; i++) {
    const attempt = crypto.randomUUID();
    const response = await request(api, 'report-stalled', attempt, { stage: 'health', token: '' });
    assert.equal((await response.json()).reported, false);
    await request(api, 'connect', attempt);
  }
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM installer_incidents').get().n, 0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM installer_rejections').get().n, 1);
  advance(minutes(6)); await monitor.tick();
  assert.match(mail[0].text, /credential_rejected: 100/);
});
test('only a successful hosting response enables timeout reporting for a new attempt', async t => {
  const { monitor, sql } = setup(t); await monitor.tick();
  const attempt = crypto.randomUUID();
  const fixture = providerFixture(); const api = createApi({ release, monitor, fetchImpl: fixture.fetchImpl });
  await request(api, 'connect', attempt);
  const result = await request(api, 'report-stalled', attempt, { stage: 'health', token: '' });
  assert.equal((await result.json()).supportReference, attempt);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM installer_incidents').get().n, 1);
});
test('reporting session and incident capacity are bounded while existing attempts can recover', async t => {
  const { monitor, incident, sql } = setup(t);
  const add = sql.prepare('INSERT INTO installer_attempts (attempt, updated) VALUES (?, ?)');
  for (let i = 1; i < 1000; i++) add.run(crypto.randomUUID(), Date.now());
  assert.equal(await monitor.authorize(crypto.randomUUID(), "a".repeat(64)), false);
  assert.equal(await monitor.authorize(incident.attempt, "a".repeat(64)), true);
  const insert = sql.prepare("INSERT INTO installer_incidents (attempt, action, category, version, occurred, updated) VALUES (?, 'publish', 'browser_timeout', '1.0.0', ?, ?)");
  for (let i = 0; i < 5000; i++) insert.run(crypto.randomUUID(), Date.now(), Date.now());
  assert.equal(await monitor.record(incident), false);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM installer_incidents').get().n, 5000);
  assert.equal(sql.prepare("SELECT total FROM installer_rejections WHERE category = 'reporting_capacity'").get().total, 2);
});
test('digest includes pending totals and puts API failures ahead of browser reports', async t => {
  const { monitor, incident, advance, mail, sql } = setup(t);
  const insert = sql.prepare("INSERT INTO installer_incidents (attempt, action, category, version, occurred, updated) VALUES (?, 'health', 'browser_timeout', '1.0.0', ?, ?)");
  for (let i = 0; i < 60; i++) insert.run(crypto.randomUUID(), Date.now(), Date.now());
  await monitor.record(incident); advance(minutes(6)); await monitor.tick();
  assert.match(mail[0].text, /61 setup step/);
  assert.ok(mail[0].text.indexOf(incident.attempt) < mail[0].text.indexOf('Category: browser_timeout'));
});

test('a connected attempt reports release verification failures without another hosting call', async t => {
  const { monitor, incident, sql } = setup(t); await monitor.tick();
  const fixture = providerFixture(); fixture.options.badChecksum = true;
  const api = createApi({ release, monitor, fetchImpl: fixture.fetchImpl });
  const result = await request(api, 'verify-release', incident.attempt);
  assert.equal(result.status, 502);
  assert.equal((await result.json()).supportReference, incident.attempt);
  assert.equal(sql.prepare('SELECT action FROM installer_incidents').get().action, 'verify-release');
  assert.equal(fixture.calls.some(c => new URL(c.url).hostname === 'api.godaddy.com'), false);
});

test('one valid token cannot fill the attempt registry with new browser sessions', async t => {
  const { monitor, sql } = setup(t); await monitor.tick();
  const api = createApi({ release, monitor, fetchImpl: async () => Response.json({ items: [] }) });
  const attempts = Array.from({ length: 1001 }, () => crypto.randomUUID());
  for (const attempt of attempts) assert.equal((await request(api, 'connect', attempt)).status, 200);
  const key = await reportingCredentialKey(token);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM installer_attempts WHERE credential_key = ?').get(key).n, 20);
  const second = crypto.randomUUID();
  await request(api, 'connect', second, { token: 'another-test-token' });
  assert.ok(sql.prepare('SELECT attempt FROM installer_attempts WHERE attempt = ?').get(second));
  // Existing sessions can recover even at their quota and after token replacement.
  await request(api, 'connect', attempts[0], { token: 'replacement-test-token' });
  assert.equal(sql.prepare('SELECT credential_key FROM installer_attempts WHERE attempt = ?').get(attempts[0]).credential_key, key);
  assert.equal((await (await request(api, 'report-stalled', attempts[0], { stage: 'health' })).json()).reported, true);
  assert.equal((await (await request(api, 'report-stalled', attempts[1000], { stage: 'health' })).json()).reported, false);
  assert.equal(sql.prepare("SELECT total FROM installer_rejections WHERE category = 'reporting_capacity'").get().total, 981);
  const stored = JSON.stringify(sql.prepare('SELECT * FROM installer_attempts').all());
  assert(!stored.includes(token)); assert(!stored.includes('another-test-token'));
});
test('registration quota is atomic, fingerprints rotate daily and expire with idle attempts', async t => {
  const { monitor, sql, advance } = setup(t);
  const time = Date.UTC(2026, 9, 17, 12);
  const key = await reportingCredentialKey(token, time);
  assert.equal(key, await reportingCredentialKey(token, time + minutes(1)));
  assert.notEqual(key, await reportingCredentialKey(token, time + minutes(24 * 60)));
  assert.equal(await monitor.authorize(crypto.randomUUID(), token), false);
  const accepted = await Promise.all(Array.from({ length: 100 }, () => monitor.authorize(crypto.randomUUID(), key)));
  assert.equal(accepted.filter(Boolean).length, 20);
  advance(minutes(24 * 60 + 1)); await monitor.tick();
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM installer_attempts').get().n, 0);
});
test('monitor remains unavailable until the registration-budget migration is applied', async t => {
  const { monitor, sql } = setup(t); await monitor.tick();
  sql.exec('DROP INDEX installer_attempts_credential_key; ALTER TABLE installer_attempts DROP COLUMN credential_key');
  assert.equal(await monitor.ready(), false);
});
