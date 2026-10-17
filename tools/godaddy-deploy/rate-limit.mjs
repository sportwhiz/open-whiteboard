export async function allowRequest(request, env) {
  if (!env.INSTALLER_LIMIT || !env.INSTALLER_GLOBAL_LIMIT) return false;
  // Cloudflare supplies this header. Only a daily digest reaches its limiter;
  // neither the address nor the digest is stored in diagnostics or logs.
  const address = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bytes = new TextEncoder().encode(`${new Date().toISOString().slice(0, 10)}:${address}`);
  const key = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (!(await env.INSTALLER_LIMIT.limit({ key })).success) return false;
  return (await env.INSTALLER_GLOBAL_LIMIT.limit({ key: 'installer' })).success;
}
