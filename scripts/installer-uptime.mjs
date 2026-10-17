import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export async function probe(url, { fetchImpl = fetch, pause = sleep } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || target.pathname !== '/healthz') {
    throw new Error('Configure an HTTPS installer /healthz URL without credentials or query parameters.');
  }
  let reason = 'request failed';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(target, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
      const body = await response.text();
      const ready = body.length < 1024 && JSON.parse(body).ready === true;
      if (response.status === 200 && ready) return { healthy: true, reason: 'ready' };
      reason = `HTTP ${response.status}; ready=${ready}`;
    } catch { reason = 'request failed or invalid health response'; }
    if (attempt < 2) await pause(5000);
  }
  return { healthy: false, reason };
}

export async function report({ result, repository, recipient, token, runUrl, exercise = false, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[\w-]+$/.test(recipient)) throw new Error('Invalid monitor repository or recipient.');
  const title = exercise ? '[Monitor test] GoDaddy installer outage' : '[Monitor] GoDaddy installer outage';
  const api = async (path, method = 'GET', body) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub notification request failed: HTTP ${response.status}`);
    return response.json();
  };
  // Paginate so unrelated issues cannot hide an existing incident and cause spam.
  let existing;
  for (let page = 1; ; page++) {
    const items = await api(`/issues?state=open&per_page=100&page=${page}`);
    existing = items.find(issue => !issue.pull_request && issue.title === title && issue.user?.login === 'github-actions[bot]');
    if (existing || items.length < 100) break;
    if (page >= 20) throw new Error('Too many open issues to safely identify the current incident.');
  }
  if (result.healthy) {
    if (!existing) return 'unchanged';
    await api(`/issues/${existing.number}`, 'PATCH', { state: 'closed', state_reason: 'completed', body: `${existing.body || ''}\n\nThe installer health check has recovered. [Recovery check](${runUrl}).` });
    return 'recovered';
  }
  if (existing) return 'unchanged';
  await api('/issues', 'POST', {
    title, assignees: [recipient],
    body: `@${recipient}, the GoDaddy installer failed three health checks.\n\n${result.reason}\n\n[Check result](${runUrl}). Inspect the installer Worker, its scheduled trigger, D1 and email delivery before inviting another installation. This monitor runs on GitHub and does not use the installer's email service.${exercise ? '\n\nThis is a controlled notification test; it does not indicate a real outage.' : ''}`,
  });
  return 'opened';
}

export async function main(env = process.env) {
  const mode = env.MONITOR_EXERCISE || 'none';
  if (!['none', 'outage', 'recovery'].includes(mode)) throw new Error('Invalid monitor exercise.');
  const result = mode === 'none' ? await probe(env.INSTALLER_HEALTH_URL) : { healthy: mode === 'recovery', reason: 'Controlled outage test' };
  const action = await report({ result, repository: env.GITHUB_REPOSITORY, recipient: env.MONITOR_RECIPIENT, token: env.GITHUB_TOKEN, runUrl: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`, exercise: mode !== 'none' });
  console.log(JSON.stringify({ healthy: result.healthy, notification: action, exercise: mode }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
