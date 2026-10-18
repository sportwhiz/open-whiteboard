// Only this fixed host receives the user's GoDaddy credential.
import { failureCategory, reportingCredentialKey } from './monitoring.mjs';
export const GODADDY = 'https://api.godaddy.com/v1/hosting';
const MAX_ZIP = 32 * 1024 * 1024;
// Workers does not supply Node's default User-Agent. GoDaddy rejects an empty one.
const USER_AGENT = 'OpenWhiteboardInstaller/1.0';
export const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
class PublicError extends Error {
  constructor(message, status = 400, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
const fail = (message, status) => { throw new PublicError(message, status); };
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) fail('Invalid operation or application identifier.');
  return value;
}
function origin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw 0;
    return url.origin;
  } catch { fail('GoDaddy has not supplied a valid HTTPS app address yet. Try continuing in a moment.', 409); }
}

function previewAddress(value) {
  // GoDaddy currently returns its authenticated dashboard wrapper for Preview,
  // not the application origin. Never configure host.godaddy.com as AUTH_ORIGIN.
  try {
    const url = new URL(value);
    if (url.origin === 'https://host.godaddy.com' && /^\/nodejs\/projects\/[A-Za-z0-9_-]+\/preview$/.test(url.pathname) && !url.search && !url.hash && !url.username && !url.password) return { link: url.href };
  } catch { /* Fall through to strict origin validation. */ }
  const address = origin(value);
  return { link: address, origin: address };
}

export async function limitedBytes(response, limit) {
  if (!response.ok || Number(response.headers.get('content-length') || 0) > limit) fail('The release could not be downloaded. Try again later.', 502);
  const reader = response.body?.getReader();
  if (!reader) fail('The release download was empty.', 502);
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) fail('The release exceeds the installer download limit.', 502);
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function operation(value, key) {
  const status = ['PENDING', 'IN_PROGRESS', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(value.status) ? value.status : 'PENDING';
  return { [key]: id(value[key]), status, ...(value.app?.id ? { appId: id(value.app.id) } : {}) };
}
export function createApi({ release, fetchImpl = fetch, monitor }) {
  // Shared cache contains only a public, checksum-verified release. Never credentials.
  let zipPromise;
  async function zip() {
    if (release.qualified !== true) fail("The GoDaddy installer is waiting for a release that passes its live hosting checks. No app has been created. Please try again after the next release.", 503);
    if (!zipPromise) zipPromise = (async () => {
      if (!/^https:\/\/github\.com\/sportwhiz\/open-whiteboard\/releases\/download\/v[\w.-]+\/open-whiteboard-node\.zip$/.test(release.url) || !/^[a-f0-9]{64}$/.test(release.sha256)) fail('The installer release configuration is invalid.', 503);
      const bytes = await limitedBytes(await fetchImpl(release.url, { signal: AbortSignal.timeout(90_000), redirect: 'follow', headers: { 'User-Agent': USER_AGENT } }), MAX_ZIP);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
      if (digest !== release.sha256) fail('Release checksum verification failed. No package was uploaded.', 502);
      return bytes;
    })().catch(error => { zipPromise = undefined; throw error; });
    return zipPromise;
  }
  return async function api(request) {
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
    let attempt, action, contactedProvider = false;
    const report = category => monitor?.record({ attempt, action, category }, { aggregateUnverified: contactedProvider }).catch(() => false);
    try {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'Open the installer directly to continue.' }, 403);
      if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'JSON is required.' }, 415);
      let raw;
      try { raw = await limitedBytes(new Response(request.body), 12_000); }
      catch { fail('Enter a valid installer request under 12 KB.', 400); }
      let input; try { input = JSON.parse(new TextDecoder().decode(raw)); } catch { fail('Invalid installer request.'); }
      if (!input || typeof input !== 'object') fail('Invalid installer request.');
      ({ action, attempt } = input);
      const { token } = input;
      if (action === "release-status") return json({ version: release.version, qualified: release.qualified === true, monitoringReady: monitor ? await monitor.ready() : null });
      if (action === 'report-stalled') {
        action = input.stage;
        const reported = await report('browser_timeout');
        return json({ reported: Boolean(reported), ...(reported ? { supportReference: attempt } : {}) });
      }
      if (monitor && (typeof attempt !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(attempt))) fail('Reload the installer to start a new setup session.');
      if (monitor && ['connect', 'create'].includes(action) && !await monitor.ready()) return json({ error: 'The installer is temporarily unavailable. Please try again later. No new app was created.' }, 503);
      if (typeof token !== 'string' || token.length < 8 || token.length > 4096 || /\s/.test(token)) fail('Enter a valid GoDaddy personal access token.');
      if (release.qualified !== true && ['create', 'configure', 'upload', 'attach', 'publish'].includes(action)) fail('The GoDaddy installer is waiting for a release that passes its live hosting checks. No app has been created. Please try again after the next release.', 503);
      let credentialKey;
      const call = async (path, method = 'GET', body, patch = false, contentType) => {
        const outgoing = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT };
        if (method === 'POST' || method === 'PATCH') {
          if (typeof input.key !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.key)) fail('Invalid retry identifier.');
          outgoing['Idempotency-Key'] = input.key;
        }
        if (body) outgoing['Content-Type'] = contentType || (patch ? 'application/json-patch+json' : 'application/json');
        let response;
        contactedProvider = true;
        try {
          response = await fetchImpl(`${GODADDY}${path}`, { method, headers: outgoing, body: contentType ? body : body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(90_000) });
        } catch { fail('GoDaddy could not be reached. Continue to retry the same step safely.', 502); }
        // Workers rejects redirect:'error'. Never follow a provider redirect or
        // forward its credential; normalize it to a retryable gateway failure.
        if (response.status >= 300 && response.status < 400) fail('GoDaddy returned an unexpected redirect. Continue to retry the same step safely.', 502);
        if (!response.ok) {
          const messages = {
            401: 'GoDaddy rejected this token. Check that it is a current personal access token.',
            403: 'GoDaddy denied access. Check the hosting permissions listed below and that Hosting API access is available for your account.',
            404: 'GoDaddy could not find this app or operation. Check the saved app identifier in your GoDaddy dashboard.',
            409: 'GoDaddy may still be processing this step, or the plan is unavailable. Wait a moment and continue; if the conflict remains, check your GoDaddy dashboard.',
            429: 'GoDaddy is busy. Wait a moment, then continue the same deployment.',
            501: 'This GoDaddy account or hosting product does not support this operation.',
          };
          const seconds = Math.max(5, Math.min(300, Number(response.headers.get('retry-after')) || 10));
          throw new PublicError(messages[response.status] || 'GoDaddy could not complete this step. Check your app in the GoDaddy dashboard, then continue.', response.status >= 500 ? 502 : response.status, response.status === 429 ? seconds : undefined);
        }
        if (monitor) {
          credentialKey ||= await reportingCredentialKey(token);
          await monitor.authorize(attempt, credentialKey).catch(() => false);
        }
        if (response.status === 204) return {};
        // Never forward upstream logs, errors or secret values to the browser.
        return response.json();
      };
      const appPath = () => `/apps/${id(input.appId)}`;
      let result;
      switch (action) {
        case 'connect': {
          const plans = await call('/subscriptions?hostingProduct=WEB_HOSTING');
          result = { release: { version: release.version }, plans: (plans.items || []).filter(p => p.hostingProduct === 'WEB_HOSTING').map(p => ({ id: id(p.subscriptionId), name: String(p.label || p.tier || 'Hosting plan').slice(0, 200), available: p.status === 'ACTIVE' && Number(p.availableSlots) > 0, slots: Number(p.availableSlots) || 0 })) };
          break;
        }
        case 'verify-release': await zip(); result = { verified: true }; break;
        case 'create': {
          if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || /[\x00-\x1f]/.test(input.name)) fail('Enter an app name between 1 and 100 characters.');
          result = operation(await call('/apps?appType=NODEJS', 'POST', { name: input.name.trim() }), 'operationId'); break;
        }
        case 'app-operation': result = operation(await call(`/app-operations/${id(input.operationId)}`), 'operationId'); break;
        case 'addresses': {
          const app = await call(appPath());
          result = { preview: previewAddress(app.urls?.preview).link, publish: origin(app.urls?.publish) }; break;
        }
        case 'configure': {
          if (!['PREVIEW', 'PUBLISH'].includes(input.variant)) fail('Invalid deployment environment.');
          if (typeof input.passphrase !== 'string' || input.passphrase.trim().length < 16 || input.passphrase.length > 256) fail('Choose a setup passphrase of 16 to 256 characters.');
          const app = await call(appPath());
          const address = input.variant === 'PREVIEW' ? previewAddress(app.urls?.preview).origin : origin(app.urls?.publish);
          const settings = { ...(address ? { AUTH_ORIGIN: address } : {}), SETUP_PASSWORD: input.passphrase, HUDDLE_PLATFORM: 'godaddy', GODADDY_APP_ID: input.appId, GODADDY_VARIANT: input.variant, HUDDLE_DATABASE_NAMESPACE: input.variant === 'PREVIEW' ? 'preview' : 'live' };
          await call(`${appPath()}/secrets?variant=${input.variant}`, 'PATCH', Object.entries(settings).map(([name, value]) => ({ op: 'add', path: `/${name}`, value })), true);
          result = { configured: true }; break;
        }
        case 'upload': {
          // A stable multipart boundary makes even byte-for-byte retries identical.
          const boundary = `whiteboard-${id(input.key)}`;
          const body = new Blob([`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="open-whiteboard-node.zip"\r\nContent-Type: application/zip\r\n\r\n`, await zip(), `\r\n--${boundary}--\r\n`]);
          result = operation(await call(`${appPath()}/imports`, 'POST', body, false, `multipart/form-data; boundary=${boundary}`), 'importId'); break;
        }
        case 'import': result = operation(await call(`${appPath()}/imports/${id(input.importId)}`), 'importId'); break;
        case 'attach': await call(`${appPath()}/subscription`, 'PUT', { subscriptionId: id(input.planId) }); result = { attached: true }; break;
        case 'publish': result = operation(await call(`${appPath()}/deployments`, 'POST', {}), 'deploymentId'); break;
        case 'deployment': result = operation(await call(`${appPath()}/deployments/${id(input.deploymentId)}`), 'deploymentId'); break;
        case 'health': {
          const app = await call(appPath());
          const address = origin(app.urls?.publish);
          // New apps use this provider-owned domain. Do not turn this endpoint into
          // an arbitrary URL fetcher, and never send the PAT to application code.
          if (!/^[a-z0-9-]+\.c[0-9]+\.airoapp\.ai$/.test(new URL(address).hostname)) fail('This app uses an unsupported health-check address. Open the app to verify its setup.', 409);
          try {
            const response = await fetchImpl(`${address}/healthz`, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': USER_AGENT } });
            const data = JSON.parse(new TextDecoder().decode(await limitedBytes(response, 8192)));
            result = { ready: data.ready === true };
          } catch { result = { ready: false }; }
          break;
        }
        case 'status': {
          const status = await call(`${appPath()}/status`);
          const published = status.variants?.find(v => v.variant === 'PUBLISH');
          // Some accounts omit PUBLISH here even after a completed deployment.
          // Distinguish absent metadata from an explicit stopped/failed app.
          result = { known: Boolean(published) || ['SUSPENDED', 'FAILED', 'STOPPED'].includes(status.status), running: status.status === 'ACTIVE' && Boolean(published && (published.status === 'RUNNING' || (published.status === 'ACTIVE' && published.lifecycleState?.toLowerCase() === 'running')) && !['SUSPENDED', 'FAILED', 'STOPPED'].includes(published.lifecycleState?.toUpperCase())) }; break;
        }
        default: fail('Unknown installer action.');
      }
      if (['FAILED', 'CANCELLED'].includes(result?.status)) {
        if (await report('operation_failed')) result.supportReference = attempt;
      } else if ((!result?.status || result.status === 'COMPLETED') && result?.ready !== false && !(result?.known === true && !result.running)) {
        const related = { create: ['create', 'app-operation'], 'app-operation': ['create', 'app-operation'], upload: ['upload', 'import'], import: ['upload', 'import'], publish: ['publish', 'deployment'], deployment: ['publish', 'deployment'] };
        for (const resolvedAction of related[action] || [action]) await monitor?.resolve(attempt, resolvedAction).catch(() => {});
      }
      return json(result);
    } catch (error) {
      const status = error instanceof PublicError ? error.status : 502;
      const reported = await report(failureCategory(status));
      return json({ error: error instanceof PublicError ? error.message : 'The installer could not complete this request. Continue to retry the same step.', ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}), ...(reported ? { supportReference: attempt } : {}) }, status);
    }
  };
}
