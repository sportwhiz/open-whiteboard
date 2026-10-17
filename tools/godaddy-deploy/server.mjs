import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createApi, headers } from './api.mjs';
const assets = new Map([['/source-sans-3.woff2', ['source-sans-3.woff2', 'font/woff2']], ['/SourceSans3-OFL.txt', ['SourceSans3-OFL.txt', 'text/plain']], ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/flow.js', ['flow.js', 'text/javascript']], ['/preview.js', ['preview.js', 'text/javascript']], ['/brand.svg', ['brand.svg', 'image/svg+xml']], ['/godaddy.svg', ['godaddy.svg', 'image/svg+xml']], ['/godaddy-black.svg', ['godaddy-black.svg', 'image/svg+xml']], ['/style.css', ['style.css', 'text/css']], ['/agent-prompt.txt', ['agent-prompt.txt', 'text/plain']]]);
export function createInstallerServer({ api, publicOrigin }) {
return createServer(async (req, res) => {
  try {
    const path = new URL(req.url, publicOrigin).pathname;
    if (path === '/api' && req.method === 'POST') {
      const request = new Request(`${publicOrigin}/api`, { method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half' });
      const response = await api(request); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
    }
    const asset = assets.get(path);
    if (!asset || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404, headers); res.end('Not found'); return; }
    const bytes = await readFile(new URL(`./public/${asset[0]}`, import.meta.url));
    res.writeHead(200, { ...headers, 'Content-Type': `${asset[1]}; charset=utf-8` }); res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(500, headers); res.end('The installer could not complete the request.'); }
});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = JSON.parse(await readFile(new URL('./release.json', import.meta.url), 'utf8'));
  const port = Number(process.env.PORT || 5305);
  const hostname = process.env.HOST || '127.0.0.1';
  const publicOrigin = process.env.LAUNCHER_ORIGIN || `http://127.0.0.1:${port}`;
  if (new URL(publicOrigin).origin !== publicOrigin) throw new Error('LAUNCHER_ORIGIN must be an origin without a path or trailing slash.');
  if (hostname !== '127.0.0.1' && !publicOrigin.startsWith('https://')) throw new Error('Set LAUNCHER_ORIGIN to the public HTTPS origin before exposing the installer.');
  createInstallerServer({ api: createApi({ release }), publicOrigin }).listen(port, hostname, () => console.log(`GoDaddy installer: ${publicOrigin}`));
}
