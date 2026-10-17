import release from './release.json';
import { createApi, headers } from './api.mjs';
import { createMonitor } from './monitoring.mjs';
import { allowRequest } from './rate-limit.mjs';
let api, boundEnv;
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const monitor = createMonitor(env, release.version);
    if (path === '/healthz') {
      const ready = Boolean(env.INSTALLER_LIMIT && env.INSTALLER_GLOBAL_LIMIT) && await monitor.ready();
      return Response.json({ ready }, { status: ready ? 200 : 503, headers });
    }
    if (path === '/api') {
      if (!await allowRequest(request, env)) return Response.json({ error: 'The installer is busy. Please try again in a minute.', retryAfter: 60 }, { status: 429, headers });
      if (!api || boundEnv !== env) { api = createApi({ release, monitor }); boundEnv = env; }
      return api(request);
    }
    const asset = await env.ASSETS.fetch(request);
    return new Response(asset.body, { status: asset.status, headers: { ...Object.fromEntries(asset.headers), ...headers } });
  },
  async scheduled(_event, env) { await createMonitor(env, release.version).tick(); },
};
