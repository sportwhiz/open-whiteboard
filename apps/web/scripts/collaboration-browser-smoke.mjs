import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:5192');
assert(['localhost', '127.0.0.1'].includes(origin.hostname));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? (
  existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined
) });
const email = `browser-peer-${Date.now()}@local.test`;
const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const peerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { 'X-Whiteboard-Dev-Email': email } });
for (const context of [ownerContext, peerContext]) await context.addInitScript(() => {
  const NativeSocket = WebSocket; window.testSockets = []; window.presenceSent = 0;
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      // Disconnect board sync, not Vite's development reload channel.
      if (![args[1]].flat().includes('vite-hmr')) window.testSockets.push(this);
    }
    send(data) { if (typeof data === 'string' && JSON.parse(data).type === 'presence') window.presenceSent++; super.send(data); }
  };
});
const request = async (context, path, method = 'GET', data) => {
  const response = await context.request.fetch(new URL(path, origin).href, { method, data });
  assert(response.ok(), `${path}: ${await response.text()}`); return response.json();
};
let workbook, board;
const errors = [];
try {
  workbook = await request(ownerContext, '/api/v1/workbooks', 'POST', { title: 'Browser collaboration regression' });
  board = await request(ownerContext, '/api/v1/boards', 'POST', { title: 'Browser collaboration regression', workbookId: workbook.id });
  const path = `/api/v1/boards/${board.id}`;
  await request(ownerContext, `${path}/bootstrap`);
  await request(ownerContext, `${path}/commands`, 'POST', { operationId: 'seed', operations: [
    { type: 'create_note', text: 'Shared idea', x: 0, y: 0 },
    { type: 'create_frame', title: 'Workshop', x: -100, y: -100, width: 800, height: 500 },
  ] });
  const invitation = await request(ownerContext, `${path}/share`, 'POST', { email, role: 'editor' });
  await request(peerContext, '/api/v1/invitations/accept', 'POST', { token: invitation.token });
  const peerUser = (await request(peerContext, '/api/v1/me')).user;
  const owner = await ownerContext.newPage(), peer = await peerContext.newPage();
  for (const page of [owner, peer]) {
    page.setDefaultTimeout(15_000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(new URL(`/boards/${board.id}`, origin).href); await page.locator('.creation-rail').waitFor();
  }
  const edit = async page => {
    await page.getByRole('button', { name: 'Find on board', exact: true }).click();
    const search = page.getByRole('textbox', { name: 'Search board text' });
    await search.fill('Shared idea'); await search.press('Enter'); await search.press('Escape'); await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Edit sticky note', exact: true }).waitFor();
  };
  const saved = page => page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved');
  const text = page => page.evaluate(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:paragraph')[0].text.toString());
  await edit(owner); await edit(peer);
  await Promise.all([owner.keyboard.insertText(' OWNER '), peer.keyboard.insertText(' PEER ')]);
  await saved(owner); await saved(peer); assert.equal(await text(owner), await text(peer));
  assert((await text(owner)).includes('OWNER') && (await text(owner)).includes('PEER'));
  await ownerContext.setOffline(true); await owner.evaluate(() => window.testSockets.forEach(s => s.close()));
  await owner.keyboard.insertText(' OFFLINE '); await peer.keyboard.insertText(' ONLINE ');
  await ownerContext.setOffline(false); await saved(owner);
  await peer.waitForFunction(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:paragraph')[0].text.toString().includes('OFFLINE'));
  assert.equal(await text(owner), await text(peer));
  await owner.keyboard.press('Escape'); await peer.keyboard.press('Escape');
  // An observer must not grow someone else's note or acquire local undo items.
  await owner.evaluate(() => {
    const doc = document.querySelector('whiteboard-editor').doc;
    const note = doc.getModelsByFlavour('affine:note')[0];
    doc.updateBlock(note, { edgeless: { ...note.props.edgeless, whiteboardText: { size: 'auto' } } });
  });
  await saved(owner);
  await peer.waitForFunction(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note')[0].props.edgeless.whiteboardText?.size === 'auto');
  await peer.evaluate(() => document.querySelector('whiteboard-editor').doc.resetHistory());
  const height = page => page.evaluate(() => JSON.parse(document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note')[0].props.xywh)[3]);
  const originalHeight = await height(owner);
  await owner.bringToFront();
  await edit(owner);
  await owner.evaluate(async () => {
    await document.fonts.ready;
    Object.defineProperty(document.fonts, 'status', { configurable: true, get: () => 'loading' });
  });
  await owner.keyboard.insertText(' A longer shared thought that should grow only on the author’s computer.'.repeat(16));
  await saved(owner);
  await owner.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await height(owner), originalHeight, 'Fallback font measurements changed the shared geometry');
  await owner.evaluate(() => {
    delete document.fonts.status;
    document.fonts.dispatchEvent(new FontFaceSetLoadEvent('loadingdone', { fontfaces: [] }));
  });
  await owner.waitForFunction(h => JSON.parse(document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note')[0].props.xywh)[3] > h, originalHeight);
  const grown = await height(owner);
  await peer.waitForFunction(h => JSON.parse(document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note')[0].props.xywh)[3] === h, grown);
  assert.equal(await peer.evaluate(() => document.querySelector('whiteboard-editor').doc.canUndo), false, 'Remote auto-fit created a local undo item');
  await peer.evaluate(() => document.querySelector('whiteboard-editor').doc.undo());
  assert.equal(await height(peer), grown);
  await owner.keyboard.press('Escape');
  const resetZoom = async page => {
    await page.getByRole('button', { name: 'Zoom options', exact: true }).click();
    await page.getByRole('button', { name: '100%', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.zoom-value').textContent === '100%');
  };
  await resetZoom(peer); await peer.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await peer.waitForFunction(() => document.querySelector('.zoom-value').textContent === '83%');
  await peer.mouse.move(1100, 800); await peer.mouse.wheel(200, 150);
  await peer.waitForFunction(() => Object.keys(localStorage).some(k => k.startsWith('whiteboard-viewport-v1:') && Math.abs(JSON.parse(localStorage[k]).zoom - 1 / 1.2) < .001));
  const view = () => peer.evaluate(() => JSON.parse(localStorage[Object.keys(localStorage).find(k => k.startsWith('whiteboard-viewport-v1:'))]));
  const ownView = await view();
  // A background tab may never receive its first animation frame. Closing it
  // must not replace the personal view with the engine's default camera.
  const unseen = await peerContext.newPage();
  await unseen.addInitScript(() => {
    const frame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => {
      if (new Error().stack.includes('fitEditorToContent')) { window.heldInitialFit = true; return 0; }
      return frame(callback);
    };
  });
  await unseen.goto(new URL(`/boards/${board.id}`, origin).href);
  await unseen.locator('.creation-rail').waitFor();
  assert.equal(await unseen.evaluate(() => window.heldInitialFit), true);
  await unseen.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await unseen.close();
  assert.deepEqual(await view(), ownView, 'An unseen tab overwrote the saved camera');

  await resetZoom(owner); await owner.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await owner.waitForFunction(() => document.querySelector('.zoom-value').textContent === '120%');
  await peer.getByRole('button', { name: '2 people online', exact: true }).click();
  await peer.getByRole('button', { name: 'Follow', exact: true }).click();
  await peer.waitForFunction(() => document.querySelector('.zoom-value').textContent === '120%');
  await peer.waitForTimeout(350); const sent = await peer.evaluate(() => window.presenceSent);
  await peer.waitForTimeout(500);
  assert((await peer.evaluate(() => window.presenceSent)) - sent <= 1, 'Following created a camera/presence feedback loop');
  assert.deepEqual(await view(), ownView, 'Following overwrote the personal camera');
  await peer.reload(); await peer.locator('.creation-rail').waitFor();
  await peer.waitForFunction(() => document.querySelector('.zoom-value').textContent === '83%');
  assert.deepEqual(await view(), ownView);
  for (const gesture of ['toolbar', 'keyboard']) {
    if (!await peer.getByRole('button', { name: 'Follow', exact: true }).isVisible())
      await peer.getByRole('button', { name: '2 people online', exact: true }).click();
    await peer.getByRole('button', { name: 'Follow', exact: true }).click();
    await peer.locator('.follow-banner').waitFor();
    await peer.waitForFunction(() => document.querySelector('.zoom-value').textContent === '120%');
    if (gesture === 'toolbar') await peer.getByRole('button', { name: 'Zoom out', exact: true }).click();
    else {
      await peer.locator('.editor-canvas').focus();
      await peer.keyboard.press(process.platform === 'darwin' ? 'Meta+-' : 'Control+-');
    }
    await peer.locator('.follow-banner').waitFor({ state: 'hidden' });
  }
  await owner.getByRole('button', { name: 'Present', exact: true }).click();
  await owner.getByRole('button', { name: 'Present 1 frame', exact: true }).click();
  await peer.locator('.follow-banner').waitFor();
  await owner.getByRole('button', { name: 'End', exact: true }).click();
  await peer.locator('.follow-banner').waitFor({ state: 'hidden' });
  await request(ownerContext, `${path}/collaborators/${peerUser.id}`, 'DELETE');
  await peer.waitForFunction(() => document.querySelector('.editor-canvas')?.inert === true);
  assert(await peer.evaluate(() => document.querySelector('whiteboard-editor').doc.readonly));
  assert.deepEqual(errors, []);
  console.log('Browser collaboration passed: two real roles, simultaneous text, offline merge, font-ready auto-fit and observer undo isolation, final camera publication, no follow feedback loop, saved personal view, presentation and live revocation.');
} finally {
  if (board) await request(ownerContext, `/api/v1/boards/${board.id}/catalog`, 'DELETE').catch(console.error);
  if (workbook) await request(ownerContext, `/api/v1/workbooks/${workbook.id}`, 'DELETE').catch(console.error);
  await browser.close();
}
