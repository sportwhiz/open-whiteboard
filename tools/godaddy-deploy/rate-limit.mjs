function callerNetwork(address) {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) {
    const parts = address.split('.');
    return parts.every(p => Number(p) <= 255 && String(Number(p)) === p) ? parts.join('.') : 'unknown';
  }
  if (!address.includes(':') || !/^[a-f0-9:.]+$/i.test(address)) return 'unknown';
  try {
    // The URL parser validates and canonicalizes compressed and embedded IPv4 forms.
    const canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1);
    const [left, right] = canonical.split('::').map(part => part ? part.split(':') : []);
    const words = right ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    const values = words.map(word => parseInt(word, 16));
    if (values.slice(0, 5).every(word => word === 0) && values[5] === 0xffff) {
      return [values[6] >> 8, values[6] & 255, values[7] >> 8, values[7] & 255].join('.');
    }
    return values.slice(0, 4).map(word => word.toString(16)).join(':') + '::/64';
  } catch { return 'unknown'; }
}
export async function allowRequest(request, env) {
  if (!env.INSTALLER_LIMIT || !env.INSTALLER_GLOBAL_LIMIT) return false;
  // Cloudflare supplies this header. IPv6 callers share their /64 allowance.
  // Neither the address nor the daily digest is stored in diagnostics or logs.
  const address = callerNetwork(request.headers.get('CF-Connecting-IP') || 'unknown');
  const bytes = new TextEncoder().encode(`${new Date().toISOString().slice(0, 10)}:${address}`);
  const key = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (!(await env.INSTALLER_LIMIT.limit({ key })).success) return false;
  return (await env.INSTALLER_GLOBAL_LIMIT.limit({ key: 'installer' })).success;
}
