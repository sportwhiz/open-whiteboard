// Store only this allowlisted metadata. Never pass requests, provider bodies,
// app/account identifiers, credentials, or error objects to the monitor.
const actions = new Set(['connect', 'verify-release', 'create', 'app-operation', 'addresses', 'configure', 'upload', 'import', 'attach', 'publish', 'deployment', 'health', 'status', 'release', 'preview', 'live']);
const categories = new Set(['credential_rejected', 'access_denied', 'rate_limited', 'provider_unavailable', 'request_failed', 'operation_failed', 'browser_timeout']);
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const address = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
export function failureCategory(status) {
  return ({ 401: 'credential_rejected', 403: 'access_denied', 429: 'rate_limited' })[status] || (status >= 500 ? 'provider_unavailable' : 'request_failed');
}
export function createMonitor(env, version, now = () => Date.now()) {
  const db = env.INSTALLER_ALERTS;
  const configured = () => Boolean(db && env.EMAIL?.send && address.test(env.ALERT_TO || '') && address.test(env.ALERT_FROM || '') && env.ALERT_DELIVERY_VERIFIED === 'true');
  return {
    async ready() {
      if (!configured()) return false;
      try {
        await db.prepare('SELECT attempt FROM installer_incidents LIMIT 1').first();
        const row = await db.prepare('SELECT heartbeat, delivery_failed FROM installer_alert_state WHERE id = 1').first();
        return Boolean(row && row.heartbeat > now() - 15 * 60_000 && !row.delivery_failed);
      } catch { return false; }
    },
    async record({ attempt, action, category }) {
      if (!configured() || !uuid.test(attempt || '') || !actions.has(action) || !categories.has(category)) return false;
      // Version comes from the pinned release, never the browser.
      const safeVersion = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? version : 'unknown';
      try {
        await db.prepare(`INSERT INTO installer_incidents (attempt, action, category, version, occurred, updated)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (attempt, action) DO UPDATE SET category = excluded.category, updated = excluded.updated, resolved = 0`)
          .bind(attempt, action, category, safeVersion, now(), now()).run();
        return true;
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
      // Atomic lease prevents overlapping cron runs from sending the same batch.
      const claimed = await db.prepare('UPDATE installer_alert_state SET lease_until = ? WHERE id = 1 AND lease_until < ? AND next_send <= ?')
        .bind(time + 10 * 60_000, time, time).run();
      if (!claimed.meta.changes) return;
      const { results } = await db.prepare('SELECT attempt, action, category, version, occurred, updated FROM installer_incidents WHERE resolved = 0 AND reported = 0 AND occurred <= ? ORDER BY occurred LIMIT 50')
        .bind(time - 5 * 60_000).all();
      if (!results.length) {
        await db.prepare('UPDATE installer_alert_state SET lease_until = 0 WHERE id = 1').run();
        return;
      }
      const text = `GoDaddy installation failures\n\n${results.length} setup step(s) still need attention. Retries that recovered before this check are excluded.\n\n` + results.map(row =>
        `Support reference: ${row.attempt}\nStep: ${row.action}\nCategory: ${row.category}\nRelease: ${row.version}\nFirst seen: ${new Date(row.occurred).toISOString()}`
      ).join('\n\n') + '\n\nBrowser timeouts are reported by the installer page. Other categories come from installer API results. This report contains no provider logs, credentials, app names, or board content.\n';
      try {
        await env.EMAIL.send({ to: env.ALERT_TO, from: env.ALERT_FROM, subject: 'Open Whiteboard: GoDaddy setup needs attention', text });
        await db.batch([
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
