import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:5192');
assert(['localhost', '127.0.0.1'].includes(origin.hostname), 'Use a disposable local development server.');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? (
  existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined
) });
/** Board chrome behaviour: focus after menus, creation, arrangement, zoom and
 * right-click menus. Uses its own boards so earlier steps cannot mask it. */
async function canvasChrome(page, request, mod) {
  const workbook = await request('/api/v1/workbooks', 'POST', { title: 'Canvas chrome regression' });
  const boards = [];
  const board = async operations => {
    const created = await request('/api/v1/boards', 'POST', { title: 'Canvas chrome regression', workbookId: workbook.id });
    boards.push(created.id);
    await request(`/api/v1/boards/${created.id}/bootstrap`);
    if (operations.length) await request(`/api/v1/boards/${created.id}/commands`, 'POST', { operationId: 'seed', operations });
    await page.goto(new URL(`/boards/${created.id}`, origin).href);
    await page.locator('.creation-rail').waitFor();
    await page.waitForFunction(() => window.auditController?.state);
    return created;
  };
  const input = page.getByRole('textbox', { name: 'Edit sticky note', exact: true });
  const texts = () => page.evaluate(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').map(n => n.children.map(c => c.text.toString()).join('')));
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
  const notes = page.locator('[data-testid="edgeless-note-container"]');
  // Wait until the camera has stopped moving (fit and zoom animate).
  // Wait until the camera has stopped: still for 5 frames AND for at least
  // 300ms, so a fit animation that starts late (slow runners) is not missed.
  const settleCamera = () => page.evaluate(() => new Promise(resolve => {
    let last = '', still = 0, stillSince = performance.now();
    const tick = () => {
      const { x, y, zoom } = window.auditController.camera();
      const now = `${x.toFixed(2)},${y.toFixed(2)},${zoom.toFixed(4)}`;
      if (now === last) still += 1; else { still = 0; stillSince = performance.now(); }
      last = now;
      if (still >= 5 && performance.now() - stillSince >= 300) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  try {
    // An empty board's call to action creates a note and starts writing, so
    // typing goes into the note rather than tool shortcuts.
    await board([]);
    await page.getByRole('button', { name: 'Add a sticky note', exact: true }).click();
    await input.waitFor();
    await page.keyboard.type('first test');
    assert.deepEqual(await texts(), ['first test'], 'Empty-state note did not take typing');
    await page.keyboard.press('Escape');

    // A lane drawn first sits beneath note 3.
    const frame = [{ type: 'create_shape', ref: 'lane', shape: 'rect', x: -20, y: 240, width: 900, height: 250 },
      { type: 'create_frame', ref: 'f', title: 'Ideas', x: -40, y: -80, width: 1000, height: 600 }];
    for (const [i, x, y] of [[0, 0, 0], [1, 300, 40], [2, 600, 90], [3, 0, 260]]) frame.push({ type: 'create_note', ref: `n${i}`, frameRef: 'f', text: `Note ${i}`, x, y, color: i === 1 ? 'blue' : 'yellow' });
    await board(frame);
    await page.getByRole('button', { name: 'Fit board', exact: true }).click();

    // R1: Escape from a formatting menu while writing returns the caret.
    for (const menu of ['Text color', 'Text alignment', 'Note color']) {
      await notes.nth(0).dblclick(); await input.waitFor(); await page.keyboard.press('End');
      await page.getByRole('button', { name: menu, exact: true }).click();
      await page.keyboard.press('Escape');
      assert.equal(await focused(), 'Edit sticky note', `${menu}: Escape did not return to the note`);
      await page.keyboard.type('!');
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    }
    assert.equal((await texts())[0], 'Note 0!!!');
    // R2: choosing paper while writing keeps the caret in the note.
    await notes.nth(0).dblclick(); await input.waitFor(); await page.keyboard.press('End');
    await page.getByRole('button', { name: 'Note color', exact: true }).click();
    await page.getByRole('button', { name: 'Mint sticky note', exact: true }).click();
    await page.keyboard.type('?');
    assert.equal((await texts())[0], 'Note 0!!!?', 'Typing after a paper change went astray');
    await page.keyboard.press('Escape');
    // API notes use the same palette, so the current family shows as chosen.
    await notes.nth(1).click();
    await page.getByRole('button', { name: 'Note color', exact: true }).click();
    assert.equal(await page.locator('.paper-colors [aria-pressed="true"]').getAttribute('aria-label'), 'Blue sticky note');
    await page.keyboard.press('Escape');
    assert.equal(await focused(), 'Note color');

    // P6: Shift-click while writing ends the edit and extends the selection.
    await notes.nth(2).dblclick(); await input.waitFor();
    await notes.nth(3).click({ modifiers: ['Shift'] });
    await input.waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.auditController.state().selection.length === 2);

    // P1/P3: notes in a frame can be arranged from the selection toolbar.
    await notes.nth(0).click(); await notes.nth(1).click({ modifiers: ['Shift'] }); await notes.nth(2).click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Arrange selection', exact: true }).click();
    await page.getByRole('button', { name: 'Align top', exact: true }).click();
    const tops = await page.evaluate(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').slice(0, 3).map(n => JSON.parse(n.props.xywh)[1]));
    assert.equal(new Set(tops).size, 1, `Frame notes were not aligned: ${tops}`);
    assert.equal(await page.evaluate(() => Object.keys(document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:frame')[0].props.childElementIds).length), 4, 'Arranged notes left their frame');
    await page.keyboard.press('Escape');

    // P7: a right-click opens a menu for the selection; Escape returns focus.
    await notes.nth(1).click({ button: 'right' });
    await page.getByRole('menu', { name: 'Selection actions' }).waitFor();
    assert.equal(await page.evaluate(() => window.auditController.state().selection.length), 3, 'Right-click narrowed the selection');
    await page.getByRole('menuitem', { name: 'Distribute horizontally' }).click();
    await page.getByRole('menu').waitFor({ state: 'detached' });
    await notes.nth(3).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Duplicate/ }).click();
    await page.waitForFunction(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').length === 5);
    await page.mouse.click(1300, 900, { button: 'right' });
    await page.getByRole('menu', { name: 'Board actions' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'detached' });
    assert.equal(await focused(), 'EDITOR-HOST');

    // R3: Escape in a tool's options returns to Select; the next click on a
    // note selects it instead of stacking a new note on top.
    await page.getByRole('button', { name: 'Sticky note options', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.creation-rail [aria-label="Select"]')?.getAttribute('aria-pressed') === 'true');
    await notes.nth(0).click();
    assert.equal(await page.evaluate(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').length), 5);

    // Layer shortcuts win over type-to-edit, and move a selection as a block
    // keeping its own order.
    const layers = () => page.evaluate(() => {
      const editor = document.querySelector('whiteboard-editor');
      const notes = editor.doc.getModelsByFlavour('affine:note');
      return { indexes: notes.map(n => n.index), texts: notes.map(n => n.children.map(c => c.text.toString()).join('')) };
    });
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await notes.nth(1).click();
    const beforeLayer = await layers();
    await page.keyboard.press(']');
    await page.waitForFunction(() => { const ns = document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note'); return ns.every(n => n === ns[1] || n.index < ns[1].index); });
    assert.equal(await input.count(), 0, '] started editing the note');
    assert.deepEqual((await layers()).texts, beforeLayer.texts, '] changed note text');
    await notes.nth(2).click(); await notes.nth(3).click({ modifiers: ['Shift'] });
    const pair = (await layers()).indexes;
    const lowerFirst = pair[2] < pair[3];
    await page.keyboard.press('[');
    await page.waitForFunction(() => { const ns = document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note'); return [0, 1, 4].filter(i => ns[i]).every(i => ns[i].index > ns[2].index && ns[i].index > ns[3].index); });
    const sent = (await layers()).indexes;
    assert.notEqual(sent[2], sent[3], 'Send to back gave two objects the same index');
    assert.equal(sent[2] < sent[3], lowerFirst, 'Send to back flipped the selection order');
    // With an object selected (not being written in), shortcuts win:
    // Shift+2 zooms to it and N arms the note tool; nothing is typed.
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await notes.nth(1).click();
    const textsBefore = await texts();
    await page.keyboard.press('Shift+Digit2');
    await page.waitForFunction(() => document.querySelector('.zoom-value').textContent === '100%');
    await page.keyboard.press('n');
    await page.waitForFunction(() => document.querySelector('.creation-rail [aria-label="Sticky note"]')?.getAttribute('aria-pressed') === 'true');
    assert.equal(await input.count(), 0, 'A shortcut started editing the selected note');
    assert.deepEqual(await texts(), textsBefore, 'A shortcut was typed into the selected note');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    // Escape out of a text element keeps keys out of it.
    await page.keyboard.press('t'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.isContentEditable);
    await page.keyboard.type('Title');
    await page.keyboard.press('Escape');
    // Escape ends the edit and keeps the text selected.
    await page.waitForFunction(() => document.activeElement?.tagName === 'EDITOR-HOST' &&
      window.auditController.state().selection.map(item => item.kind).join() === 'text');
    await page.keyboard.press('Escape');
    await page.keyboard.press('s');
    const surfaceTexts = () => page.evaluate(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:surface')[0].elementModels.filter(e => e.type === 'text').map(e => e.text.toString()));
    assert.deepEqual(await surfaceTexts(), ['Title'], 'Keys after Escape leaked into the text');
    await page.keyboard.press('Escape');
    // A right-click on another object shows that object's menu, focused.
    await notes.nth(0).click();
    await notes.nth(2).click({ button: 'right' });
    await page.getByRole('menu', { name: 'Selection actions' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem', 'Menu focus fell to the page');
    assert.equal(await page.evaluate(() => window.auditController.state().selection.map(i => i.text).join()), (await texts())[2]);
    await page.keyboard.press('Escape');
    // A comment placed on a note over a lane attaches to the note (topmost).
    const anchored = page.evaluate(() => new Promise(resolve => window.addEventListener('whiteboard-comment-position', event => resolve(event.detail.objectId), { once: true })));
    await page.evaluate(() => window.dispatchEvent(new Event('whiteboard-place-comment')));
    await notes.nth(3).click({ position: { x: 30, y: 60 } });
    assert.equal(await anchored, await page.evaluate(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note')[3].id), 'Comment attached to the object underneath');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');

    // P8: N then Enter places a note mid-view and starts writing.
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await page.locator('editor-host').focus();
    await page.keyboard.press('n'); await page.keyboard.press('Enter');
    await input.waitFor(); await page.keyboard.type('keyboard note'); await page.keyboard.press('Escape');
    assert((await texts()).includes('keyboard note'));

    // A line dragged between the middles of two notes joins their facing sides.
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Fit board', exact: true }).click();
    await settleCamera();
    await page.locator('editor-host').focus();
    // Aim at the notes' model centres (not their DOM boxes, which can lag a
    // moving camera), and expect the facing sides of their actual bounds.
    const ends = await page.evaluate(() => {
      const [a, b] = document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note');
      const view = id => window.auditController.viewBounds(id);
      const host = document.querySelector('editor-host').getBoundingClientRect();
      const centre = box => [host.left + box.x + box.w / 2, host.top + box.y + box.h / 2];
      const [sa, sb] = [a.elementBound, b.elementBound];
      const dx = sb.x + sb.w / 2 - (sa.x + sa.w / 2), dy = sb.y + sb.h / 2 - (sa.y + sa.h / 2);
      const horizontal = Math.abs(dx) / ((sa.w + sb.w) / 2) >= Math.abs(dy) / ((sa.h + sb.h) / 2);
      const expected = horizontal
        ? (dx >= 0 ? { source: [1, 0.5], target: [0, 0.5] } : { source: [0, 0.5], target: [1, 0.5] })
        : (dy >= 0 ? { source: [0.5, 1], target: [0.5, 0] } : { source: [0.5, 0], target: [0.5, 1] });
      return { from: centre(view(a.id)), to: centre(view(b.id)), expected };
    });
    const centre = async index => { const box = await notes.nth(index).boundingBox(); return [box.x + box.width / 2, box.y + box.height / 2]; };
    const [from, to] = [ends.from, ends.to];
    await page.keyboard.press('l');
    await page.waitForFunction(() => window.auditController.state().tool === 'connector');
    await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move(...to, { steps: 12 }); await page.mouse.up();
    const line = await page.evaluate(() => {
      const connector = document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:surface')[0].elementModels.filter(e => e.type === 'connector').at(-1);
      return { source: connector?.source.position, target: connector?.target.position };
    });
    assert.deepEqual(line, ends.expected, 'Connector did not join the facing sides');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    // Right-drag pans even when it starts on a note, and opens no menu.
    await page.getByRole('button', { name: 'Fit board', exact: true }).click(); await settleCamera();
    const startX = (await notes.nth(2).boundingBox()).x;
    const modelBefore = await page.evaluate(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note')[2].props.xywh);
    const [px, py] = await centre(2);
    await page.mouse.move(px, py); await page.mouse.down({ button: 'right' });
    await page.mouse.move(px + 120, py + 10, { steps: 8 }); await page.mouse.up({ button: 'right' });
    // The camera pans with the drag (a drag threshold may hold back a few pixels on slow machines).
    await page.waitForFunction(x => document.querySelectorAll('[data-testid="edgeless-note-container"]')[2].getBoundingClientRect().x - x > 80, startX);
    assert.equal(await page.evaluate(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note')[2].props.xywh), modelBefore, 'Right-drag moved the note instead of panning');
    assert.equal(await page.getByRole('menu').count(), 0, 'Right-drag opened a menu');

    // Arrow-key nudges are one undo step; rapid nudges merge.
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await notes.nth(0).click();
    const xy = () => page.evaluate(() => JSON.parse(document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note')[0].props.xywh).slice(0, 2));
    const startXY = await xy();
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown');
    assert.deepEqual(await xy(), [startXY[0] + 2, startXY[1] + 10]);
    await page.keyboard.press(`${mod}+z`);
    await page.waitForFunction(start => JSON.stringify(JSON.parse(document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note')[0].props.xywh).slice(0, 2)) === JSON.stringify(start), startXY);
    // Shapes get the product toolbar; a fill change is one undo step and the
    // engine's own toolbar stays hidden.
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    const lane = await page.evaluate(() => window.auditController.state().items.find(item => item.kind === 'shape').id);
    await page.evaluate(id => window.auditController.select(id), lane); await page.waitForTimeout(600);
    await page.getByRole('toolbar', { name: 'Shape actions' }).waitFor();
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('affine-toolbar-widget')).display), 'none');
    await page.getByRole('button', { name: 'Fill color', exact: true }).click();
    await page.getByRole('button', { name: 'Mint fill', exact: true }).click();
    const fill = () => page.evaluate(id => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:surface')[0].elementModels.find(e => e.id === id).fillColor?.light, lane);
    assert.equal(await fill(), '#d2f2d0');
    await page.keyboard.press(`${mod}+z`);
    await page.waitForFunction(([id]) => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:surface')[0].elementModels.find(e => e.id === id).fillColor?.light !== '#d2f2d0', [lane]);
    // A duplicate lands beside its original without covering anything.
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await notes.nth(0).click(); await page.keyboard.press(`${mod}+d`);
    await page.waitForFunction(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').length >= 6);
    await page.waitForTimeout(300);
    const overlaps = await page.evaluate(() => {
      const boxes = document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').map(n => JSON.parse(n.props.xywh));
      const copy = boxes.at(-1);
      return boxes.slice(0, -1).filter(b => copy[0] < b[0] + b[2] && copy[0] + copy[2] > b[0] && copy[1] < b[1] + b[3] && copy[1] + copy[3] > b[1]).length;
    });
    assert.equal(overlaps, 0, 'The duplicate covered another note');
    await page.keyboard.press(`${mod}+z`);

    // R5: zoom steps land on presets; shortcuts zoom, reset and fit.
    await page.keyboard.press('Escape');
    await page.locator('editor-host').focus();
    await page.keyboard.press('Shift+Digit0'); await page.waitForFunction(() => document.querySelector('.zoom-value').textContent === '100%');
    const zoomed = value => page.waitForFunction(value => document.querySelector('.zoom-value').textContent === value, value);
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click(); await zoomed('75%');
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click(); await zoomed('67%');
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click(); await zoomed('50%');
    await page.getByRole('button', { name: 'Zoom options', exact: true }).click();
    assert.equal(await page.locator('.zoom-presets [aria-pressed="true"]').innerText(), '50%');
    await page.keyboard.press('Escape');
    await page.locator('editor-host').focus();
    await page.keyboard.press(`${mod}+Equal`); await page.waitForFunction(() => document.querySelector('.zoom-value').textContent === '67%');
    await page.keyboard.press(`${mod}+Digit0`); await page.waitForFunction(() => document.querySelector('.zoom-value').textContent === '100%');
    await page.keyboard.press(`${mod}+Minus`); await zoomed('75%');
    await page.keyboard.press('Shift+Digit1'); await page.waitForFunction(() => document.querySelector('.zoom-value').textContent !== '75%');
    await page.keyboard.press('?'); await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).getByText('Zoom to selection').waitFor();
    await page.keyboard.press('Escape');
  } finally {
    for (const id of boards) await request(`/api/v1/boards/${id}`, 'DELETE').catch(() => {});
    await request(`/api/v1/workbooks/${workbook.id}`, 'DELETE').catch(() => {});
  }
}

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
      await canvasChrome(page, request, mod);
      assert.deepEqual(errors, []);
      console.log(`${platform}: palette permissions/focus, selection, tidy/group/ungroup, quick-create style and zoom, bounded search pages and keyboard traversal, viewport reload and immediate-leave persistence, menu focus return, empty-state creation, frame arrangement, zoom steps and shortcuts, layer order, shortcuts over a selection, Escape out of text, fresh context menus, topmost comment anchors, facing-side connectors, right-drag pan from objects, undoable nudges, the shape toolbar, duplicate placement and keyboard creation passed.`);
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
