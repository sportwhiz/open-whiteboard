import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:5192');
assert(['localhost', '127.0.0.1'].includes(origin.hostname), 'Use a disposable local development server.');
// Chromium's native text selection follows the host OS even when testing a
// different application shortcut platform.
const textMod = process.platform === 'darwin' ? 'Meta' : 'Control';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? (
  existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined
) });
try {
  for (const [platform, mod] of [['MacIntel', 'Meta'], ['Win32', 'Control']]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(platform => Object.defineProperty(navigator, 'platform', { get: () => platform }), platform);
    const request = async (path, method = 'GET', data) => {
      const response = await context.request.fetch(new URL(path, origin).href, { method, data });
      assert(response.ok(), `${method} ${path}: ${await response.text()}`);
      return response.status() === 204 ? null : response.json();
    };
    const workbook = await request('/api/v1/workbooks', 'POST', { title: `Sticky regression ${platform}` });
    const board = await request('/api/v1/boards', 'POST', { title: 'Sticky interaction regression', workbookId: workbook.id });
    const path = `/api/v1/boards/${board.id}`;
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const count = () => page.evaluate(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').length);
    const texts = () => page.evaluate(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:paragraph').map(p => p.text.toString()));
    const saved = () => page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved');
    const focusCanvas = () => page.locator('.editor-canvas').focus();
    const input = page.getByRole('textbox', { name: 'Edit sticky note', exact: true });
    try {
      await request(`${path}/bootstrap`);
      await request(`${path}/commands`, 'POST', { operationId: 'seed', operations: [{ type: 'create_note', text: 'Keep this idea', x: 0, y: 0 }] });
      await page.goto(new URL(`/boards/${board.id}`, origin).href);
      await page.locator('.creation-rail').waitFor();
      const note = page.locator('[data-testid="edgeless-note-container"]').first();
      await note.click();
      await note.click({ position: { x: 100, y: 180 } });
      await input.waitFor();
      assert.equal(await note.getAttribute('data-editing'), 'false', 'Native document editor must not also open');
      for (const position of [{ x: 2, y: 2 }, { x: 104, y: 5 }, { x: 200, y: 200 }, { x: 104, y: 180 }]) {
        await page.locator('.sticky-text-editor').click({ position });
        await page.keyboard.type(' saved');
      }
      assert.equal((await texts())[0], 'Keep this idea' + ' saved'.repeat(4), 'Paper clicks lost text');
      await page.keyboard.press('Escape');
      await focusCanvas();
      await page.keyboard.type('!');
      await input.waitFor();
      assert((await texts())[0].startsWith('Keep this idea'), 'Typing on a selection replaced existing text');
      await input.evaluate(el => {
        const data = new DataTransfer();
        data.setData('text/plain', '\r\nPasted line');
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      });
      assert((await texts())[0].endsWith('!\nPasted line'), 'Multiline paste was lost');
      await page.keyboard.press(`${textMod}+a`);
      await page.keyboard.press(`${mod}+b`);
      await page.keyboard.type('Formatted idea');
      await page.keyboard.press('Escape');
      await focusCanvas();
      await page.keyboard.press(`${mod}+d`);
      await page.waitForFunction(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').length === 2);
      assert.deepEqual(await texts(), ['Formatted idea', 'Formatted idea']);
      assert(await page.evaluate(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:paragraph').every(p => p.text.toDelta().every(d => d.attributes?.bold))), 'Duplicate lost formatting');
      await page.keyboard.press(`${mod}+z`);
      await page.waitForFunction(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').length === 1);
      await page.keyboard.press(mod === 'Meta' ? 'Meta+Shift+z' : 'Control+y');
      await page.waitForFunction(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').length === 2);

      await page.locator('[data-testid="edgeless-note-container"]').nth(1).dblclick();
      await input.waitFor();
      await page.keyboard.press(`${mod}+d`);
      assert.equal(await count(), 2, 'Object shortcut ran inside a text editor');
      await page.keyboard.press(`${textMod}+a`);
      await page.keyboard.type('A long idea that stays readable as more details are added. '.repeat(12));
      await page.getByLabel('Text size', { exact: true }).selectOption('auto');
      await input.click();
      await page.waitForFunction(() => {
        const shell = document.querySelector('.sticky-text-editor');
        return shell && parseFloat(getComputedStyle(shell).fontSize) === 12 && shell.clientHeight > 208 && shell.scrollHeight <= shell.clientHeight + 1;
      });
      const editingMetrics = await input.evaluate(el => ({ size: getComputedStyle(el).fontSize, font: getComputedStyle(el).fontFamily, height: el.scrollHeight }));
      await page.keyboard.press('Escape');
      const nativeMetrics = await page.locator('[data-testid="edgeless-note-container"]').nth(1).locator('.inline-editor').evaluate(el => ({ size: getComputedStyle(el).fontSize, font: getComputedStyle(el).fontFamily, height: el.scrollHeight }));
      assert.deepEqual(nativeMetrics, editingMetrics, 'Text layout changed when leaving edit mode');
      await saved();
      const persisted = (await request(`${path}/semantic`)).board.notes.map(n => n.text).sort();
      assert.deepEqual(persisted, (await texts()).sort(), 'Typed content was not saved');
      await page.reload();
      await page.locator('.creation-rail').waitFor();
      assert.deepEqual((await texts()).sort(), persisted, 'Reload lost text');

      await page.evaluate(() => {
        const doc = document.querySelector('whiteboard-editor').doc;
        const note = doc.getModelsByFlavour('affine:note')[0];
        const [x, y, w, h] = JSON.parse(note.props.xywh);
        doc.updateBlock(note, { xywh: JSON.stringify([x, y, w * 1.5, h * 1.5]), edgeless: { ...note.props.edgeless, scale: 1.5 } });
      });
      await page.locator('[data-testid="edgeless-note-container"]').first().dblclick();
      await input.waitFor();
      const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      assert.deepEqual(await input.evaluate(rect), await page.locator('[data-testid="edgeless-note-container"]').first().locator('.inline-editor').evaluate(rect), 'Resized note jumped when editing');
      await page.keyboard.press('Tab');
      await page.waitForFunction(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').length === 3);
      await input.waitFor();
      await page.keyboard.type('Next idea');
      assert((await texts()).includes('Next idea'), 'Tab did not focus the new note');
      assert.equal(await page.getByLabel('Text size', { exact: true }).inputValue(), 'm', 'Next notes should preserve their source text size');
      await page.keyboard.press('Escape');
      await focusCanvas();
      await page.getByRole('button', { name: 'Fit board', exact: true }).click();
      // Shift-click preserves a multi-selection without depending on the
      // native Select All shortcut's focus scope.
      const notes = page.locator('[data-testid="edgeless-note-container"]');
      await notes.nth(0).click();
      await notes.nth(1).click({ modifiers: ['Shift'] });
      await notes.nth(2).click({ modifiers: ['Shift'] });
      await focusCanvas();
      await page.keyboard.press(`${mod}+d`);
      await page.waitForFunction(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').length === 6);
      await saved();
      // Rich document notes must keep their multi-block editor and data.
      await page.evaluate(() => {
        const doc = document.querySelector('whiteboard-editor').doc;
        const note = doc.getModelsByFlavour('affine:note')[0];
        doc.addBlock('affine:paragraph', { type: 'text', text: new note.children[0].text.constructor('Second paragraph') }, note.id);
      });
      await notes.first().click();
      await notes.first().click();
      await page.waitForFunction(() => document.querySelector('[data-testid="edgeless-note-container"]')?.dataset.editing === 'true');
      assert.equal(await input.count(), 0, 'Simple editor flattened a rich document note');
      assert((await texts()).includes('Second paragraph'));
      assert.deepEqual(errors, [], 'Browser raised errors');
      console.log(`${platform}: paper clicks, selection typing, multiline paste, formatting, duplicate, undo/redo, text-input shortcut exclusion, auto fit/growth, matching display, save/reload, resized text, Tab, multi-selection and rich-note fallback passed.`);
    } finally {
      await request(path, 'DELETE').catch(() => {});
      await request(`/api/v1/workbooks/${workbook.id}`, 'DELETE').catch(() => {});
      await context.close();
    }
  }
} finally {
  await browser.close();
}
