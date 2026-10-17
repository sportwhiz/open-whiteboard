// Store only this allowlisted metadata. Never pass requests, provider bodies,
// app/account identifiers, raw credentials, or error objects to the monitor.
// A short-lived credential fingerprint bounds reporting registrations.
const actions = new Set(['connect', 'verify-release', 'create', 'app-operation', 'addresses', 'configure', 'upload', 'import', 'attach', 'publish', 'deployment', 'health', 'status', 'release', 'preview', 'live']);
const categories = new Set(['credential_rejected', 'access_denied', 'rate_limited', 'provider_unavailable', 'request_failed', 'operation_failed', 'browser_timeout']);
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const address = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
export function failureCategory(status) {
  return ({ 401: 'credential_rejected', 403: 'access_denied', 429: 'rate_limited' })[status] || (status >= 500 ? 'provider_unavailable' : 'request_failed');
}
export async function reportingCredentialKey(token, time = Date.now()) {
  const bytes = new TextEncoder().encode(`whiteboard-reporting:${new Date(time).toISOString().slice(0, 10)}:${token}`);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function createMonitor(env, version, now = () => Date.now()) {
  const db = env.INSTALLER_ALERTS;
  const configured = () => Boolean(db && env.EMAIL?.send && address.test(env.ALERT_TO || '') && address.test(env.ALERT_FROM || '') && env.ALERT_DELIVERY_VERIFIED === 'true');
  async function known(attempt) {
    return uuid.test(attempt || '') && Boolean(await db.prepare('SELECT attempt FROM installer_attempts WHERE attempt = ? AND updated > ?').bind(attempt, now() - 24 * 60 * 60_000).first());
  }
  async function aggregate(category) {
    await db.prepare(`INSERT INTO installer_rejections (category, total, updated) VALUES (?, 1, ?)
      ON CONFLICT (category) DO UPDATE SET total = total + 1, updated = CASE WHEN total = reported THEN excluded.updated ELSE updated END`).bind(category, now()).run();
  }
  return {
    // Only successful GoDaddy responses establish a reporting session. Store no
    // raw credential, account identifier, app name, or network address.
    async authorize(attempt, credentialKey) {
      if (!configured() || !uuid.test(attempt || '') || !/^[a-f0-9]{64}$/.test(credentialKey || '')) return false;
      try {
        await db.prepare(`INSERT INTO installer_attempts (attempt, updated, credential_key)
          SELECT ?, ?, ? WHERE ((SELECT COUNT(*) FROM installer_attempts) < 1000
            AND (SELECT COUNT(*) FROM installer_attempts WHERE credential_key = ?) < 20)
            OR EXISTS (SELECT 1 FROM installer_attempts WHERE attempt = ?)
          ON CONFLICT (attempt) DO UPDATE SET updated = excluded.updated`).bind(attempt, now(), credentialKey, credentialKey, attempt).run();
        const accepted = await known(attempt);
        if (!accepted) await aggregate("reporting_capacity");
        return accepted;
      } catch { return false; }
    },
    async credentialForAttempt(attempt, token) {
      if (!configured() || !uuid.test(attempt || '') || typeof token !== 'string' || token.length < 8 || token.length > 4096) return null;
      try {
        const row = await db.prepare('SELECT credential_key FROM installer_attempts WHERE attempt = ? AND updated > ?').bind(attempt, now() - 24 * 60 * 60_000).first();
        // An installation can cross midnight; accept only the recorded token,
        // never the public support reference alone.
        for (const time of [now(), now() - 24 * 60 * 60_000]) {
          const key = await reportingCredentialKey(token, time);
          if (row?.credential_key === key) return key;
        }
      } catch { /* New requests retain the shared admission limit. */ }
      return null;
    },
    async ready() {
      if (!configured()) return false;
      try {
        await db.prepare('SELECT attempt, credential_key FROM installer_attempts LIMIT 1').first();
        await db.prepare('SELECT category FROM installer_rejections LIMIT 1').first();
        const row = await db.prepare('SELECT heartbeat, delivery_failed FROM installer_alert_state WHERE id = 1').first();
        return Boolean(row && row.heartbeat > now() - 15 * 60_000 && !row.delivery_failed);
      } catch { return false; }
    },
    async record({ attempt, action, category }, { aggregateUnverified = false } = {}) {
      if (!configured() || !uuid.test(attempt || '') || !actions.has(action) || !categories.has(category)) return false;
      // Version comes from the pinned release, never the browser.
      const safeVersion = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? version : 'unknown';
      try {
        if (!await known(attempt)) {
          // Unauthenticated failures cannot fill the incident queue. Aggregate
          // only upstream failure categories into a fixed number of counters.
          if (aggregateUnverified && category !== 'browser_timeout') await aggregate(category);
          return false;
        }
        // Resolved details are no longer alertable. Free their capacity before
        // admission; an attacker still cannot exceed 5,000 unresolved rows.
        await db.prepare('DELETE FROM installer_incidents WHERE resolved = 1').run();
        const result = await db.prepare(`INSERT INTO installer_incidents (attempt, action, category, version, occurred, updated)
          SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM installer_incidents) < 5000
            OR EXISTS (SELECT 1 FROM installer_incidents WHERE attempt = ? AND action = ?)
          ON CONFLICT (attempt, action) DO UPDATE SET category = excluded.category, updated = excluded.updated,
            reported = CASE WHEN installer_incidents.resolved = 1 THEN 0 ELSE installer_incidents.reported END,
            occurred = CASE WHEN installer_incidents.resolved = 1 THEN excluded.occurred ELSE installer_incidents.occurred END,
            resolved = 0`)
          .bind(attempt, action, category, safeVersion, now(), now(), attempt, action).run();
        if (!result.meta.changes) await aggregate("reporting_capacity");
        return Boolean(result.meta.changes);
      } catch { return false; }
    },
    async resolve(attempt, action) {
      if (!configured() || !uuid.test(attempt || '') || !actions.has(action)) return;
      try { await db.prepare('UPDATE installer_incidents SET resolved = 1 WHERE attempt = ? AND action = ?').bind(attempt, action).run(); } catch { /* Do not hide the original operation result. */ }
    },
    async tick() {
      if (!configured()) return;
      const time = now();
      await db.prepare('UPDATE installer_alert_state SET heartbeat = ? WHERE id = 1').bind(time).run();
      await db.prepare('DELETE FROM installer_incidents WHERE updated < ?').bind(time - 30 * 24 * 60 * 60_000).run();
      await db.prepare('DELETE FROM installer_rejections WHERE updated < ?').bind(time - 30 * 24 * 60 * 60_000).run();
      await db.prepare('DELETE FROM installer_attempts WHERE updated <= ?').bind(time - 24 * 60 * 60_000).run();
      // Atomic lease prevents overlapping cron runs from sending the same batch.
      const claimed = await db.prepare('UPDATE installer_alert_state SET lease_until = ? WHERE id = 1 AND lease_until < ? AND next_send <= ?')
        .bind(time + 10 * 60_000, time, time).run();
      if (!claimed.meta.changes) return;
      const { results } = await db.prepare("SELECT attempt, action, category, version, occurred, updated FROM installer_incidents WHERE resolved = 0 AND reported = 0 AND occurred <= ? ORDER BY CASE WHEN category = 'browser_timeout' THEN 1 ELSE 0 END, occurred LIMIT 50")
        .bind(time - 5 * 60_000).all();
      const total = (await db.prepare('SELECT COUNT(*) AS n FROM installer_incidents WHERE resolved = 0 AND reported = 0 AND occurred <= ?').bind(time - 5 * 60_000).first()).n;
      const { results: rejections } = await db.prepare('SELECT category, total, reported FROM installer_rejections WHERE total > reported AND updated <= ?').bind(time - 5 * 60_000).all();
      // Existing installs can recover while email is down. If that empties the
      // queue, still verify sending before lifting the new-installation gate.
      const recoveryCheck = !results.length && !rejections.length && Boolean((await db.prepare('SELECT delivery_failed FROM installer_alert_state WHERE id = 1').first())?.delivery_failed);
      if (!results.length && !rejections.length && !recoveryCheck) {
        await db.prepare('UPDATE installer_alert_state SET lease_until = 0 WHERE id = 1').run();
        return;
      }
      const text = recoveryCheck
        ? 'An earlier attempt to send an installer alert failed. This message checks whether email delivery is working again. It contains no installation details.\n'
        : `GoDaddy installation failures\n\n${total} setup step(s) still need attention; ${results.length} are included below. Retries that recovered before this check are excluded.\n\n` + results.map(row =>
        `Support reference: ${row.attempt}\nStep: ${row.action}\nCategory: ${row.category}\nRelease: ${row.version}\nFirst seen: ${new Date(row.occurred).toISOString()}`
      ).join('\n\n') + '\n\nBrowser timeouts are reported by the installer page. Other categories come from installer API results. This report contains no provider logs, credentials, app names, or board content.\n';
      const rejectionText = rejections.length ? '\n\nUnverified requests and reporting capacity (aggregate counts only):\n' + rejections.map(row => `${row.category}: ${row.total - row.reported}`).join('\n') : '';
      try {
        await env.EMAIL.send({ to: env.ALERT_TO, from: env.ALERT_FROM, subject: recoveryCheck ? 'Open Whiteboard: installer email check' : 'Open Whiteboard: GoDaddy setup needs attention', text: text + rejectionText });
        await db.batch([
          ...rejections.map(row => db.prepare('UPDATE installer_rejections SET reported = ? WHERE category = ?').bind(row.total, row.category)),
          ...results.map(row => db.prepare('UPDATE installer_incidents SET reported = 1 WHERE attempt = ? AND action = ? AND updated = ?').bind(row.attempt, row.action, row.updated)),
          db.prepare('UPDATE installer_alert_state SET lease_until = 0, next_send = ?, delivery_failed = 0 WHERE id = 1').bind(time + 60 * 60_000),
        ]);
      } catch {
        // A provider-accepted message can still fail to reach an inbox. An
        // ambiguous response can cause a duplicate with the same support refs.
        await db.prepare('UPDATE installer_alert_state SET lease_until = 0, next_send = ?, delivery_failed = 1 WHERE id = 1').bind(time + 5 * 60_000).run();
      }
    },
  };
}
