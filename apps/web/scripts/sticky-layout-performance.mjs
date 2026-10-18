import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:5192');
assert(['localhost', '127.0.0.1'].includes(origin.hostname));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? (
  existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined
) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const request = async (path, method = 'GET', data) => {
  const response = await context.request.fetch(new URL(path, origin).href, { method, data });
  assert(response.ok(), `${path}: ${await response.text()}`); return response.json();
};
let workbook;
const boards = [];
try {
  workbook = await request('/api/v1/workbooks', 'POST', { title: 'Automatic layout performance' });
  for (const count of [200, 1000]) {
    const board = await request('/api/v1/boards', 'POST', { title: `${count} automatic notes`, workbookId: workbook.id }); boards.push(board.id);
    const path = `/api/v1/boards/${board.id}`;
    await request(`${path}/bootstrap`);
    for (let offset = 0; offset < count; offset += 100) await request(`${path}/commands`, 'POST', {
      operationId: `seed-${offset}`, operations: Array.from({ length: Math.min(100, count - offset) }, (_, j) => ({
        type: 'create_note', text: `Idea ${offset + j + 1}\nA useful thought for the workshop.`, x: j % 10 * 260, y: Math.floor((offset + j) / 10) * 260,
      })),
    });
    const page = await context.newPage(); page.setDefaultTimeout(60_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(new URL(`/boards/${board.id}`, origin).href); await page.locator('.creation-rail').waitFor();
    const id = await page.evaluate(async () => {
      const editor = document.querySelector('whiteboard-editor'); const d = editor.doc;
      d.transact(() => d.getModelsByFlavour('affine:note').forEach(n => d.updateBlock(n, { edgeless: { ...n.props.edgeless, whiteboardText: { size: 'auto' } } })));
      await document.fonts.ready;
      const { createCanvasController } = await import('/src/blocksuite/canvas-controller.ts');
      const id = d.getModelsByFlavour('affine:note')[0].id; createCanvasController(editor).select(id); return id;
    });
    await page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved');
    await page.locator(`[data-block-id="${id}"] [data-testid="edgeless-note-container"]`).dblclick();
    await page.getByRole('textbox', { name: 'Edit sticky note', exact: true }).waitFor();
    await page.waitForFunction(count => {
      const notes = [...document.querySelectorAll('[data-whiteboard-sticky]')];
      return notes.length === count && notes.every(e => e.style.getPropertyValue('--sticky-auto-size') && e.querySelector('.inline-editor'));
    }, count);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => {
      const styles = new WeakMap(Array.from(document.querySelectorAll('[data-whiteboard-sticky]'), e => [e.style, e.dataset.blockId]));
      window.measuredNotes = new Set(); window.fitWrites = 0; window.longTasks = [];
      const original = CSSStyleDeclaration.prototype.setProperty;
      CSSStyleDeclaration.prototype.setProperty = function(key, ...values) {
        if (key === '--sticky-auto-size') { window.fitWrites++; window.measuredNotes.add(styles.get(this)); }
        return original.call(this, key, ...values);
      };
      new PerformanceObserver(list => window.longTasks.push(...list.getEntries().map(e => Math.round(e.duration)))).observe({ type: 'longtask' });
    });
    const started = performance.now();
    await page.keyboard.type(' More detail added during the session.');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await page.evaluate(() => ({ measuredNotes: [...window.measuredNotes], sizingWrites: window.fitWrites, longTasks: window.longTasks }));
    assert.deepEqual(result.measuredNotes, [id], 'Typing remeasured unrelated notes');
    const typingMs = Math.round(performance.now() - started);
    await page.evaluate(() => { window.measuredNotes.clear(); window.fitWrites = 0; });
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+a`); await page.keyboard.press(`${mod}+b`);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await page.evaluate(() => [...window.measuredNotes]), [id], 'Formatting did not invalidate the changed note measurement');
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.measuredNotes.clear();
      document.fonts.dispatchEvent(new FontFaceSetLoadEvent('loadingdone', { fontfaces: [new FontFace('Unrelated fixture font', 'local(Arial)')] }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.deepEqual(await page.evaluate(() => [...window.measuredNotes]), [], 'An unrelated font must not remeasure the board');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved');
    await page.reload(); await page.locator('.creation-rail').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-whiteboard-sticky]')].every(e => {
      const t = e.querySelector('.inline-editor'); const scale = Number(e.querySelector('[data-scale]')?.dataset.scale || 1);
      return t && t.scrollHeight <= parseFloat(e.style.height) / scale - 48 + 1;
    }));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ notes: count, typedCharacters: 37, typingMs, ...result, richFormattingInvalidation: true, reloadFitsAllNotes: true }));
    await page.close();
  }
} finally {
  for (const id of boards) await request(`/api/v1/boards/${id}/catalog`, 'DELETE').catch(console.error);
  if (workbook) await request(`/api/v1/workbooks/${workbook.id}`, 'DELETE').catch(console.error);
  await browser.close();
}
