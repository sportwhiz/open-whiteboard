import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:5192');
assert(['localhost', '127.0.0.1'].includes(origin.hostname), 'Use a disposable local development server.');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? (
  existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined
) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
if (process.env.CANVAS_CPU_THROTTLE) {
  const session = await context.newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CANVAS_CPU_THROTTLE) });
}
if (process.env.CANVAS_TRACE_PATH) await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
page.setDefaultTimeout(15_000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const request = async (path, method = 'GET', data) => {
  const response = await context.request.fetch(new URL(path, origin).href, { method, data });
  assert(response.ok(), `${method} ${path}: ${await response.text()}`);
  return response.json();
};
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const drag = async (from, to, button = 'left') => {
  await page.mouse.move(...from); await page.mouse.down({ button });
  await page.mouse.move(...to, { steps: 24 }); await page.mouse.up({ button }); await frame();
};
const note = page.locator('[data-testid="edgeless-note-container"]').first();
const box = () => note.boundingBox();
const equal = (actual, expected, message) => assert(Math.abs(actual - expected) < 1.5, `${message}: ${actual} vs ${expected}`);
const model = () => page.evaluate(() => JSON.parse(document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note')[0].props.xywh));
const count = () => page.evaluate(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').length);
let workbook, board;
try {
  workbook = await request('/api/v1/workbooks', 'POST', { title: 'Canvas gesture regression' });
  board = await request('/api/v1/boards', 'POST', { title: 'Canvas gesture regression', workbookId: workbook.id });
  await page.goto(new URL(`/boards/${board.id}`, origin).href);
  await page.locator('.creation-rail').waitFor();
  await page.getByRole('button', { name: 'Sticky note', exact: true }).click();
  await page.mouse.click(460, 360);
  await page.getByRole('textbox', { name: 'Edit sticky note', exact: true }).waitFor();
  await page.keyboard.type('Draggable idea'); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'EDITOR-HOST');
  let before = await box(); const savedBox = await model();
  await page.keyboard.down('Space'); await drag([1100, 750], [1020, 690]); await page.keyboard.up('Space');
  let after = await box(); equal(after.x, before.x - 80, 'Space-drag after editing'); equal(after.y, before.y - 60, 'Space-drag y');
  assert.deepEqual(await model(), savedBox, 'Panning moved the object in the document');
  await page.mouse.click(1200, 800);
  before = await box(); await drag([before.x + 80, before.y + 80], [before.x + 260, before.y + 190]);
  after = await box(); equal(after.x, before.x + 180, 'Object drag x'); equal(after.y, before.y + 110, 'Object drag y');
  assert.equal(await page.locator('.sticky-text-editor').count(), 0, 'Dragging opened text editing');
  const handle = await page.locator('edgeless-selected-rect .handle[aria-label="bottom-right"]').boundingBox();
  before = await box(); await drag([handle.x + handle.width / 2, handle.y + handle.height / 2], [handle.x + handle.width / 2 + 120, handle.y + handle.height / 2 + 120]);
  after = await box(); equal(after.width, before.width + 120, 'Resize width'); equal(after.height, before.height + 120, 'Resize height');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await frame(); equal((await box()).width, before.width, 'Undo resize');
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await frame(); equal((await box()).width, after.width, 'Redo resize');
  await page.mouse.click(1200, 800); before = await box();
  await drag([1100, 750], [1200, 810], 'right'); after = await box(); equal(after.x, before.x + 100, 'Right-drag');
  await page.getByRole('button', { name: 'Hand', exact: true }).click(); before = await box();
  await drag([1100, 750], [1020, 700]); after = await box(); equal(after.x, before.x - 80, 'Hand tool');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  before = await box(); await page.mouse.move(1200, 800); await page.mouse.wheel(40, 70); await frame();
  after = await box(); equal(after.x, before.x - 40, 'Wheel horizontal pan'); equal(after.y, before.y - 70, 'Wheel vertical pan');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.zoom-value').textContent === '120%');
  equal((await box()).width, after.width * 1.2, 'Zoom in');
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.zoom-value').textContent === '100%');
  before = await box(); await page.mouse.move(700, 500); await page.keyboard.down('Control'); await page.mouse.wheel(0, -240); await page.keyboard.up('Control'); await frame();
  after = await box(); const ratio = after.width / before.width;
  assert(ratio > 1, 'Trackpad-style zoom did not zoom');
  equal(after.x, 700 + (before.x - 700) * ratio, 'Zoom cursor anchor x');
  equal(after.y, 500 + (before.y - 500) * ratio, 'Zoom cursor anchor y');
  await page.getByRole('button', { name: 'Zoom options', exact: true }).click();
  await page.getByRole('button', { name: '100%', exact: true }).click(); await frame();

  await page.getByRole('button', { name: 'Find on board', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Search board text' });
  await search.fill('Draggable'); await search.press('Enter'); await search.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'EDITOR-HOST');
  // Finish the search's camera animation before checking the pan amount.
  await page.getByRole('button', { name: 'Zoom options', exact: true }).click();
  await page.getByRole('button', { name: '100%', exact: true }).click();
  await page.locator('editor-host').focus(); await frame(); before = await box();
  await page.keyboard.down('Space'); await drag([1200, 800], [1150, 770]); await page.keyboard.up('Space');
  equal((await box()).x, before.x - 50, 'Space-drag after search');

  await page.getByRole('button', { name: 'Shapes', exact: true }).click();
  await drag([1000, 250], [1220, 410]); await page.keyboard.type('Decision point'); await page.keyboard.press('Escape');
  before = await box();
  await page.getByRole('button', { name: 'Connection line', exact: true }).click();
  await drag([before.x + before.width - 2, before.y + before.height / 2], [1000, 330]);
  const elements = () => page.evaluate(() => {
    const d = document.querySelector('whiteboard-editor').doc;
    const es = d.spaceDoc.getMap('blocks').get(d.getModelsByFlavour('affine:surface')[0].id).get('prop:elements').get('value');
    return [...es.values()].map(e => ({ id: e.get('id'), type: e.get('type'), text: String(e.get('text')), xywh: e.get('xywh'), source: e.get('source'), target: e.get('target') }));
  });
  let es = await elements(); const shape = es.find(e => e.type === 'shape'); const connector = es.find(e => e.type === 'connector');
  assert.equal(shape.text, 'Decision point'); assert.equal(connector.target.id, shape.id); assert(connector.source.id);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await drag([1110, 330], [1160, 510]); es = await elements();
  // Native smart guides can snap the moved edge to a nearby object.
  assert(Math.abs(JSON.parse(es.find(e => e.id === shape.id).xywh)[1] - JSON.parse(shape.xywh)[1] - 180) < 12, 'Shape did not follow the drag');
  assert.deepEqual(es.find(e => e.id === connector.id).target, connector.target, 'Moving a shape detached its connector');
  await page.mouse.click(1300, 820); await note.click();
  await page.evaluate(() => navigator.clipboard.writeText('clipboard fixture'));
  await page.keyboard.press(`${mod}+c`);
  await page.waitForFunction(async () => (await navigator.clipboard.read()).some(item => item.types.includes('text/html')));
  await page.keyboard.press(`${mod}+v`);
  await page.waitForFunction(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').length === 2);
  assert.equal(await count(), 2, 'Native clipboard paste did not create a copy');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').length === 1);
  await page.getByRole('button', { name: 'Pen', exact: true }).click();
  await drag([350, 180], [550, 220]); assert((await elements()).some(e => e.type === 'brush'));
  await page.getByRole('button', { name: 'Text', exact: true }).click(); await page.mouse.click(400, 800); await page.keyboard.type('Canvas label'); await page.keyboard.press('Escape');
  assert((await elements()).some(e => e.type === 'text' && e.text === 'Canvas label'));
  await page.getByRole('button', { name: 'Frame', exact: true }).click(); await drag([200, 160], [1300, 850]);
  assert.equal(await page.evaluate(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:frame').length), 1);
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 120; c.height = 80; const g = c.getContext('2d'); g.fillStyle = '#4262ff'; g.fillRect(0, 0, 120, 80); return c.toDataURL('image/png').split(',')[1]; });
  await page.locator('input[type=file]').setInputFiles({ name: 'gesture-proof.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => document.querySelector('affine-edgeless-image img')?.naturalWidth === 120);
  await page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved');
  await page.reload(); await page.locator('.creation-rail').waitFor();
  await page.waitForFunction(() => document.querySelector('affine-edgeless-image img')?.naturalWidth === 120);
  assert((await elements()).some(e => e.type === 'shape' && e.text === 'Decision point'));
  // Production CSP must also allow the native shape/label font menu. Exercise
  // every registered variant, including fonts unused by this small fixture.
  const fontCount = await page.evaluate(async () => {
    const fonts = [...document.fonts].filter(font => font.family.includes('blocksuite:surface:'));
    let timer;
    try {
      await Promise.race([
        Promise.all(fonts.map(font => font.load())),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Canvas font CDN did not finish loading within 30 seconds')), 30_000); }),
      ]);
    } finally { clearTimeout(timer); }
    return fonts.length;
  });
  assert(fontCount >= 7, 'Native canvas font choices were not registered');
  assert.deepEqual(errors, []);
  console.log(`Canvas gestures passed: sticky placement, post-edit/search Space-pan, drag, resize/undo/redo, right-drag, Hand, wheel, cursor-anchored zoom, shape text, bound connectors, clipboard, drawing, labels, frames, image upload, persisted reload and ${fontCount} canvas font variants.`);
} finally {
  if (process.env.CANVAS_TRACE_PATH) await context.tracing.stop({ path: process.env.CANVAS_TRACE_PATH });
  if (board) await request(`/api/v1/boards/${board.id}/catalog`, 'DELETE').catch(console.error);
  if (workbook) await request(`/api/v1/workbooks/${workbook.id}`, 'DELETE').catch(console.error);
  await browser.close();
}
