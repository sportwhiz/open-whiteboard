import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:5192');
assert(['localhost', '127.0.0.1'].includes(origin.hostname), 'Use a disposable local development server.');
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
    const workbook = await request('/api/v1/workbooks', 'POST', { title: `Workflow regression ${platform}` });
    const board = await request('/api/v1/boards', 'POST', { title: 'Workflow regression', workbookId: workbook.id });
    const path = `/api/v1/boards/${board.id}`;
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const saved = () => page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved');
    const attach = () => page.evaluate(async () => {
      const { createCanvasController } = await import('/src/blocksuite/canvas-controller.ts');
      window.auditController = createCanvasController(document.querySelector('whiteboard-editor'));
    });
    const open = async () => { await page.locator('.editor-canvas').focus(); await page.keyboard.press(`${mod}+k`); await page.getByRole('combobox', { name: 'Search actions' }).waitFor(); };
    const run = async query => { await open(); await page.getByRole('combobox', { name: 'Search actions' }).fill(query); await page.locator('.quick-actions [role=option][aria-selected=true][aria-disabled=false]').waitFor(); await page.getByRole('combobox', { name: 'Search actions' }).press('Enter'); await page.getByRole('dialog', { name: 'Quick actions' }).waitFor({ state: 'hidden' }); };
    const count = () => page.evaluate(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').length);
    try {
      await request(`${path}/bootstrap`);
      await request(`${path}/commands`, 'POST', { operationId: 'seed', operations: [
        { type: 'create_note', text: 'Idea one', x: 0, y: 0 },
        { type: 'create_note', text: 'Idea two', x: 350, y: 0 },
      ] });
      await page.goto(new URL(`/boards/${board.id}`, origin).href);
      await page.locator('.creation-rail').waitFor(); await attach();
      await open();
      await page.getByRole('combobox', { name: 'Search actions' }).fill('next note');
      assert.equal(await page.getByRole('option', { name: /Add next note/ }).getAttribute('aria-disabled'), 'true');
      await page.keyboard.press('Tab'); assert(await page.getByRole('button', { name: 'Close quick actions' }).evaluate(e => e === document.activeElement));
      await page.keyboard.press('Tab'); assert(await page.getByRole('combobox').evaluate(e => e === document.activeElement));
      await page.keyboard.press('Escape');
      await run('select all');
      await page.waitForFunction(() => window.auditController.state().selection.length === 2);
      await run('tidy');
      await run('group selection');
      await page.waitForFunction(() => window.auditController.state().selection[0]?.kind === 'group');
      await run('ungroup');
      await page.waitForFunction(() => window.auditController.state().selection.length === 2);

      await page.evaluate(() => {
        const doc = document.querySelector('whiteboard-editor').doc;
        const note = doc.getModelsByFlavour('affine:note')[0];
        doc.updateBlock(note, { xywh: '[0,0,280,560]', background: { light: '#ded6ff', dark: '#ded6ff' },
          edgeless: { ...note.props.edgeless, collapsedHeight: 560, whiteboardText: { size: 's', font: 'serif', align: 'center' } } });
        window.auditController.select(note.id);
        window.auditController.zoom(1.2);
      });
      await page.waitForFunction(() => document.querySelector('.zoom-value').textContent === '120%');
      await page.locator('.editor-canvas').focus(); await page.keyboard.press(`${mod}+Enter`);
      const input = page.getByRole('textbox', { name: 'Edit sticky note', exact: true }); await input.waitFor();
      await page.keyboard.type('Idea three');
      assert.equal(await count(), 3);
      assert.equal(await page.locator('.zoom-value').innerText(), '120%', 'Quick create changed zoom');
      const style = await page.evaluate(() => { const n = document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').at(-1); return { style: n.props.edgeless.whiteboardText, box: JSON.parse(n.props.xywh), color: n.props.background.light }; });
      assert.deepEqual(style.style, { size: 's', font: 'serif', align: 'center' });
      assert.deepEqual(style.box.slice(2), [280, 280]); assert.equal(style.color, '#ded6ff');
      await page.keyboard.press(`${mod}+Enter`); await input.waitFor(); await page.keyboard.type('Idea four');
      assert.equal(await count(), 4);
      await page.keyboard.press('Escape'); await saved();

      await run('find on board');
      const search = page.getByRole('textbox', { name: 'Search board text' });
      await search.fill('Idea'); await search.press('Enter');
      await page.waitForFunction(() => document.querySelector('.navigator-meta')?.textContent.includes('1 of 4'));
      await search.press('Enter'); await page.waitForFunction(() => document.querySelector('.navigator-meta')?.textContent.includes('2 of 4'));
      await search.press('Shift+Enter'); await page.waitForFunction(() => document.querySelector('.navigator-meta')?.textContent.includes('1 of 4'));
      await search.press('Escape'); await page.getByLabel('Board search', { exact: true }).waitFor({ state: 'hidden' });
      assert(await page.locator('editor-host').evaluate(e => e === document.activeElement));

      await page.evaluate(() => window.auditController.zoom(1.3));
      await page.waitForFunction(() => Object.keys(localStorage).some(k => k.startsWith('whiteboard-viewport-v1:') && JSON.parse(localStorage[k]).zoom === 1.3));
      const before = await page.locator('[data-testid="edgeless-note-container"]').first().boundingBox();
      await page.reload(); await page.locator('.creation-rail').waitFor(); await attach();
      await page.waitForFunction(() => document.querySelector('.zoom-value').textContent === '130%');
      const after = await page.locator('[data-testid="edgeless-note-container"]').first().boundingBox();
      for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(before[key] - after[key]) < 1, `Reopening changed ${key}`);
      // pagehide must flush a view change even before the debounce runs.
      await page.evaluate(() => { window.auditController.zoom(1.6); window.dispatchEvent(new Event('pagehide')); });
      await page.reload(); await page.locator('.creation-rail').waitFor(); await attach();
      await page.waitForFunction(() => document.querySelector('.zoom-value').textContent === '160%');

      await page.evaluate(() => { document.querySelector('whiteboard-editor').doc.readonly = true; });
      await open(); await page.getByRole('combobox', { name: 'Search actions' }).fill('add sticky');
      assert.equal(await page.getByRole('option', { name: /Add sticky note here/ }).getAttribute('aria-disabled'), 'true');
      await page.keyboard.press('Enter'); assert.equal(await count(), 4);
      await page.getByRole('combobox').fill('fit board'); await page.keyboard.press('Enter');
      await page.getByRole('dialog', { name: 'Quick actions' }).waitFor({ state: 'hidden' });
      await page.evaluate(async () => {
        const editor = document.querySelector('whiteboard-editor');
        editor.doc.readonly = false;
        const { createSticky } = await import('/src/blocksuite/canvas-controller.ts');
        editor.doc.transact(() => {
          for (let i = 0; i < 125; i++) createSticky(editor, (i % 15) * 250, 1000 + Math.floor(i / 15) * 250, '#ded6ff', `Paged idea ${i + 1}`);
        });
      });
      await run('find on board');
      await search.fill('Paged idea');
      const results = page.locator('.canvas-navigator.search .navigator-list > button');
      await page.waitForFunction(() => document.querySelector('.navigator-meta')?.textContent.includes('125 results'));
      assert.equal(await results.count(), 50, 'Search mounted all matching objects');
      await search.press('Shift+Enter');
      await page.waitForFunction(() => document.querySelector('.navigator-meta')?.textContent.includes('125 of 125'));
      assert.equal(await results.count(), 25);
      assert(await page.getByRole('button', { name: 'Next search results', exact: true }).isDisabled());
      await search.press('Enter');
      await page.waitForFunction(() => document.querySelector('.navigator-meta')?.textContent.includes('1 of 125'));
      assert.equal(await results.count(), 50);
      await page.getByRole('button', { name: 'Next search results', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.navigator-meta')?.textContent.includes('51 of 125'));
      assert.equal(await results.count(), 50);
      await search.press('Shift+Enter');
      await page.waitForFunction(() => document.querySelector('.navigator-meta')?.textContent.includes('50 of 125'));
      await search.press('Enter');
      await page.waitForFunction(() => document.querySelector('.navigator-meta')?.textContent.includes('51 of 125'));
      await page.getByRole('button', { name: 'Previous search results', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.navigator-meta')?.textContent.includes('1 of 125'));
      await search.fill('Idea four');
      assert.equal(await results.count(), 1, 'Changing the query did not reset the result page');
      await search.press('Escape');
      // A branch from a tall sticky must preview the new square and place it
      // at the pointer, not offset by the source's old height.
      const geometry = await page.evaluate(() => {
        const doc = document.querySelector('whiteboard-editor').doc;
        const source = doc.getModelsByFlavour('affine:note')[0];
        doc.updateBlock(source, { xywh: '[0,0,280,560]', edgeless: { ...source.props.edgeless, collapsedHeight: 560 } });
        const controller = window.auditController;
        const point = controller.toViewBox({ x: 6000, y: 6000, w: 0, h: 0 });
        const preview = controller.connectionPreview(source.id, 'right', point);
        const directional = controller.connectionPreview(source.id, 'left');
        controller.connectNext('right', source.id, point);
        const created = doc.getModelsByFlavour('affine:note').at(-1);
        return { preview: preview.target, directional: directional.target, actual: JSON.parse(created.props.xywh) };
      });
      assert.deepEqual([geometry.preview.x, geometry.preview.y, geometry.preview.w, geometry.preview.h], [5860, 5860, 280, 280]);
      assert.deepEqual(geometry.actual, [5860, 5860, 280, 280], 'Created branch disagrees with its pointer preview');
      assert.deepEqual([geometry.directional.x, geometry.directional.y, geometry.directional.w, geometry.directional.h], [-376, 140, 280, 280]);
      await saved();
      assert.deepEqual(errors, []);
      console.log(`${platform}: palette permissions/focus, selection, tidy/group/ungroup, quick-create style and zoom, bounded search pages and keyboard traversal, viewport reload and immediate-leave persistence passed.`);
    } catch (error) {
      console.error(platform, await page.evaluate(() => ({ focus: document.activeElement?.outerHTML, selection: window.auditController?.state().selection, palette: document.querySelector('.quick-actions')?.textContent })));
      throw error;
    } finally {
      await request(path, 'DELETE').catch(() => {});
      await request(`/api/v1/workbooks/${workbook.id}`, 'DELETE').catch(() => {});
      await context.close();
    }
  }
} finally { await browser.close(); }
