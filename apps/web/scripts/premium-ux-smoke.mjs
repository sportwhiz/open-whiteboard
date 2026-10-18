import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:5321');
assert(['localhost', '127.0.0.1'].includes(origin.hostname), 'Use a disposable local server');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
try {
  for (const [theme, width] of [['light', 1440], ['dark', 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme });
    const request = async (path, method = 'GET', data) => {
      const response = await context.request.fetch(new URL(path, origin).href, { method, data });
      assert(response.ok(), `${method} ${path}: ${await response.text()}`);
      return response.json();
    };
    const suffix = Date.now();
    const folder = await request('/api/v1/folders', 'POST', { title: `UX projects ${suffix}` });
    const book = await request('/api/v1/workbooks', 'POST', { title: `UX review ${suffix}` });
    const destination = await request('/api/v1/workbooks', 'POST', { title: `UX destination ${suffix}` });
    const board = await request('/api/v1/boards', 'POST', { title: `UX board ${suffix}`, workbookId: book.id });
    const spare = await request('/api/v1/boards', 'POST', { title: `UX spare ${suffix}`, workbookId: book.id });
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const focused = () => page.evaluate(() => { const active = document.activeElement; return active && active !== document.body && active.getClientRects().length > 0; });
    const openNavigation = async () => { if (width < 700 && await page.getByRole('button', { name: 'Studio navigation' }).getAttribute('aria-expanded') !== 'true') await page.getByRole('button', { name: 'Studio navigation' }).click(); };
    const patches = [];
    page.on('request', item => { if (item.method() === 'PATCH' && item.url().includes('/api/v1/workbooks/')) patches.push(JSON.parse(item.postData() ?? '{}')); });

    // Views are addresses: a workbook link opens straight into that workbook.
    await page.goto(new URL(`/?workbook=${encodeURIComponent(book.id)}`, origin).href);
    await page.getByRole('heading', { level: 1, name: book.title, exact: true }).waitFor();
    assert.equal(await page.locator('h1, h2, h3').first().evaluate(element => element.tagName), 'H1', 'The page heading comes first');

    // Workbook settings: one error, inside the dialog, cleared on close.
    await page.getByRole('button', { name: 'Workbook settings', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Workbook settings' });
    await dialog.getByLabel('Workbook name').fill(`Organized ${suffix}`);
    await dialog.getByLabel('Folder').selectOption(folder.id);
    await page.route('**/api/v1/workbooks/*', route => route.request().method() === 'PATCH' ? route.fulfill({ status: 503, json: { error: 'Try again soon.' } }) : route.continue());
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('alert').count(), 1, 'A dialog error appears once');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.getByRole('alert').count(), 0, 'Dialog errors close with the dialog');
    assert(await focused(), 'Cancel returns focus to a visible control');
    await page.unroute('**/api/v1/workbooks/*');
    await page.getByRole('button', { name: 'Workbook settings', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Workbook settings' });
    await dialog.getByLabel('Workbook name').fill(`Organized ${suffix}`);
    await dialog.getByLabel('Folder').selectOption(folder.id);
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: `Organized ${suffix}`, exact: true }).waitFor();
    let catalog = (await request('/api/v1/workspace')).catalog;
    assert.equal(catalog.workbooks.find(item => item.id === book.id).folderId, folder.id);
    // A rename alone must not send a folder: co-owners cannot see each other's folders.
    await page.getByRole('button', { name: 'Workbook settings', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Workbook settings' });
    assert.equal(await dialog.getByLabel('Workbook name').evaluate(input => input.selectionEnd - input.selectionStart), `Organized ${suffix}`.length, 'The current name arrives selected');
    await page.keyboard.type(`Renamed ${suffix}`);
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(patches.at(-1), { title: `Renamed ${suffix}` });
    catalog = (await request('/api/v1/workspace')).catalog;
    assert.equal(catalog.workbooks.find(item => item.id === book.id).folderId, folder.id, 'Renaming keeps the folder');

    // Folder rows collapse, explain that they hold the open workbook, and remember it.
    await openNavigation();
    const folderToggle = page.locator(`[data-folder-id="${folder.id}"]`);
    await folderToggle.click(); assert.equal(await folderToggle.getAttribute('aria-expanded'), 'false');
    assert.match(await folderToggle.innerText(), new RegExp(folder.title));
    assert.equal(await folderToggle.evaluate(element => element.classList.contains('has-current')), true, 'A collapsed folder shows it holds the open workbook');
    await page.reload();
    await page.getByRole('heading', { name: `Renamed ${suffix}`, exact: true }).waitFor();
    await openNavigation();
    assert.equal(await folderToggle.getAttribute('aria-expanded'), 'false', 'Folder collapse survives reload');
    await folderToggle.click(); assert.equal(await folderToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator(`a[data-workbook-id="${book.id}"]`).getAttribute('aria-current'), 'page');
    if (width < 700) {
      await page.mouse.click(width / 2, 900);
      assert.equal(await page.getByRole('button', { name: 'Studio navigation' }).getAttribute('aria-expanded'), 'false', 'Tapping outside closes the drawer');
      assert(page.url().includes('workbook='), 'Tapping outside only closes the drawer');
    }

    // Card menus: arrows reach every action, Escape returns to the menu button.
    const card = page.locator(`[data-board-id="${board.id}"]`);
    const menu = card.getByLabel(`Actions for ${board.title}`, { exact: true });
    await menu.click();
    await card.locator('.board-menu-popover[data-popover=open]').waitFor();
    const items = [];
    for (let index = 0; index < 7; index++) { items.push(await page.evaluate(() => document.activeElement.textContent)); await page.keyboard.press('ArrowDown'); }
    assert.deepEqual(items, ['Add to favorites', 'Rename…', 'Move to…', 'Duplicate', 'Export archive', 'Move to trash', 'Add to favorites']);
    await page.keyboard.press('Escape'); assert(await menu.evaluate(element => element === document.activeElement));

    // Duplicate works with no options, and the copy is selected.
    await menu.click();
    await card.getByRole('button', { name: 'Duplicate', exact: true }).click();
    await page.locator('.toast-message', { hasText: `Duplicated as “${board.title} copy”` }).waitFor();
    await page.waitForFunction(title => document.activeElement?.closest('.board-card')?.textContent?.includes(title), `${board.title} copy`);

    // Rename keeps a failed draft and shows one error.
    await menu.click();
    await card.getByRole('button', { name: 'Rename…', exact: true }).click();
    await page.getByRole('dialog', { name: 'Rename board' }).getByLabel('Board name').fill('Draft retained after failure');
    await page.route('**/catalog', route => route.fulfill({ status: 503, json: { error: 'Try again soon.' } }));
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await page.getByRole('dialog').getByRole('alert').waitFor();
    assert.equal(await page.getByRole('alert').count(), 1);
    assert.equal(await page.getByRole('dialog').getByLabel('Board name').inputValue(), 'Draft retained after failure');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.unroute('**/catalog');
    assert(await menu.evaluate(element => element === document.activeElement), 'Cancel returns to the menu button');

    // Move with the picker: type, choose, and the board leaves this workbook.
    // Focus continues from the next card in reading order (else the previous one) once the card has left.
    const order = await page.locator('[data-board-id]').evaluateAll(cards => cards.map(item => item.dataset.boardId));
    const position = order.indexOf(board.id);
    const expectedFocus = order[position + 1] ?? order[position - 1];
    await menu.click();
    await card.getByRole('button', { name: 'Move to…', exact: true }).click();
    const picker = page.getByRole('dialog', { name: `Move “${board.title}”` });
    await picker.getByRole('combobox').fill(`destination ${suffix}`);
    await picker.getByRole('option', { name: destination.title, selected: true }).waitFor();
    await page.keyboard.press('Enter');
    await page.locator('.toast-message', { hasText: `Moved to ${destination.title}` }).waitFor();
    await card.waitFor({ state: 'detached' });
    await page.waitForFunction(expected => {
      const active = document.activeElement;
      return expected ? active?.classList.contains('board-card-link') && active.closest('[data-board-id]')?.getAttribute('data-board-id') === expected : active?.id === 'studio-title';
    }, expectedFocus);
    assert.equal((await request('/api/v1/workspace')).catalog.boards.find(item => item.id === board.id).workbookId, destination.id);
    // Undo moves it straight back.
    await page.locator('.toast-message', { hasText: `Moved to ${destination.title}` }).getByRole('button', { name: 'Undo' }).click();
    await page.locator('.toast-message', { hasText: `Moved back to Renamed ${suffix}` }).waitFor();
    await card.waitFor();
    assert.equal((await request('/api/v1/workspace')).catalog.boards.find(item => item.id === board.id).workbookId, book.id);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Studio overflowed');

    // Live search: titles appear at once from the catalog; note text is searched once,
    // after a pause, and superseded requests are cancelled.
    const searches = [];
    const aborted = [];
    page.on('request', item => { if (item.url().includes('/api/v1/search?')) searches.push(new URL(item.url()).searchParams.get('q')); });
    page.on('requestfailed', item => { if (item.url().includes('/api/v1/search?')) aborted.push(new URL(item.url()).searchParams.get('q')); });
    let releaseSearch;
    let searchReleased = new Promise(resolve => { releaseSearch = resolve; });
    let searchReceived;
    let received = new Promise(resolve => { searchReceived = resolve; });
    await page.route('**/api/v1/search?**', async route => { searchReceived(); await searchReleased; await route.fulfill({ json: { matches: [], complete: true } }).catch(() => undefined); });
    const search = page.getByRole('textbox', { name: 'Search boards and notes' });
    await page.locator('h1').click();
    await page.keyboard.press('/');
    assert(await search.evaluate(element => element === document.activeElement), '/ focuses search');
    await page.keyboard.type('Delayed search', { delay: 40 });
    await received;
    assert.deepEqual(searches, ['Delayed search'], 'Typing sends one note search, after the pause');
    await search.fill('   ');
    await page.getByRole('heading', { name: `Renamed ${suffix}`, exact: true }).waitFor();
    // Hold the response until the app has had the chance to cancel it; releasing
    // first would let the request finish normally and race the cancellation.
    for (const started = Date.now(); !aborted.includes('Delayed search') && Date.now() - started < 3000;) await page.waitForTimeout(25);
    assert(aborted.includes('Delayed search'), 'Leaving a search cancels its request');
    releaseSearch();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.collection-count').innerText(), '3 boards', 'A blank search does not stay "Searching…"');
    searchReleased = new Promise(resolve => { releaseSearch = resolve; });
    received = new Promise(resolve => { searchReceived = resolve; });
    await search.fill(`UX spare ${suffix}`);
    await page.waitForURL(/[?&]q=UX\+spare/u);
    await page.locator(`[data-board-id="${spare.id}"]`).waitFor();
    await received;
    assert.equal(await page.locator('.board-skeleton').count(), 0, 'Search never falls back to skeleton cards');
    await page.locator('.notes-pending').waitFor();
    await search.press('End');
    await page.keyboard.type(' x');
    await page.waitForFunction(() => document.querySelector('.workspace-empty h2')?.textContent);
    // The newer text commits after the typing pause; the older note search is cancelled then.
    for (const started = Date.now(); !aborted.includes(`UX spare ${suffix}`) && Date.now() - started < 3000;) await page.waitForTimeout(25);
    assert(aborted.includes(`UX spare ${suffix}`), 'A newer query cancels the older note search');
    releaseSearch();
    await page.unroute('**/api/v1/search?**');
    await search.fill(`UX spare ${suffix}`);
    await page.locator(`[data-board-id="${spare.id}"]`).waitFor();
    const preview = page.locator(`[data-board-id="${spare.id}"] .board-card-link`);
    const identity = await preview.evaluate(element => { element.dataset.identity = 'kept'; return true; });
    await page.getByRole('button', { name: 'All boards', exact: true }).click();
    await page.waitForURL(/scope=all/u);
    await page.locator(`[data-board-id="${spare.id}"]`).waitFor();
    assert(identity && await preview.getAttribute('data-identity') === 'kept', 'Cards stay mounted while results update');
    await search.press('Escape');
    await page.getByRole('heading', { name: `Renamed ${suffix}`, exact: true }).waitFor();
    assert.equal(await search.inputValue(), '');
    assert(await search.evaluate(element => element === document.activeElement), 'Escape keeps focus in search');
    await page.goto(new URL('/?view=favorites', origin).href);
    await page.getByRole('heading', { level: 1, name: 'Favorites' }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: `Renamed ${suffix}`, exact: true }).waitFor();

    // Notifications open on their heading, never on "Mark all as read".
    await page.getByRole('button', { name: /^Notifications/u }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'notifications-title');
    await page.keyboard.press('Escape');

    // Starring with the pointer neither scrolls nor moves the card, until the view changes.
    const spareCard = page.locator(`[data-board-id="${spare.id}"]`);
    const spareBefore = await spareCard.boundingBox();
    const scrollBefore = await page.evaluate(() => scrollY);
    await spareCard.hover();
    await spareCard.locator('.favorite-button').click();
    await page.locator('.toast-message', { hasText: 'Added to favorites' }).waitFor();
    assert.equal(await page.evaluate(() => scrollY), scrollBefore, 'Starring does not scroll');
    assert.equal(Math.round((await spareCard.boundingBox()).y), Math.round(spareBefore.y), 'Starring keeps the card in place');
    await spareCard.locator('.favorite-button').click();
    await page.locator('.toast-message', { hasText: 'Removed from favorites' }).waitFor();

    // The board grid is one tab stop; arrow keys move between cards.
    const cardIds = await page.locator('[data-board-id]').evaluateAll(cards => cards.map(item => item.dataset.boardId));
    assert.equal(await page.locator('.board-card-link[tabindex="0"]').count(), 1, 'One card link is in the tab order');
    await page.locator(`[data-board-id="${cardIds[0]}"] .board-card-link`).focus();
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-board-id]')?.getAttribute('data-board-id')), cardIds.at(-1));
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-board-id]')?.getAttribute('data-board-id')), cardIds[0]);

    // The list layout is remembered.
    await page.getByRole('button', { name: 'List view', exact: true }).click();
    await page.reload();
    await page.locator(`li.board-row[data-board-id="${spare.id}"]`).waitFor();
    await page.getByRole('button', { name: 'Grid view', exact: true }).click();
    await spareCard.locator('.board-card-link').waitFor();

    // A successful trash operation still offers Undo when refreshing the list fails.
    await spareCard.getByLabel(`Actions for ${spare.title}`, { exact: true }).click();
    await page.route('**/api/v1/catalog', route => route.fulfill({ status: 503, json: { error: 'Temporary refresh failure' } }));
    await spareCard.getByRole('button', { name: 'Move to trash', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Your change was saved' }).waitFor();
    assert.equal((await request('/api/v1/workspace')).catalog.boards.some(item => item.id === spare.id), false);
    const recovery = page.locator('.toast-message', { hasText: `Moved “${spare.title}” to the trash` }).getByRole('button', { name: 'Undo' });
    await recovery.waitFor();
    await page.unroute('**/api/v1/catalog');
    await recovery.click();
    await page.locator('.toast-message', { hasText: `Restored “${spare.title}”` }).waitFor();
    await spareCard.waitFor();

    // Trash: reversible, so no confirmation; Undo restores at once and Trash can restore later.
    await spareCard.getByLabel(`Actions for ${spare.title}`, { exact: true }).click();
    await spareCard.getByRole('button', { name: 'Move to trash', exact: true }).click();
    await spareCard.waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('dialog').count(), 0, 'Trashing one board asks for no confirmation');
    let confirm;
    await page.locator('.toast-message', { hasText: `Moved “${spare.title}” to the trash` }).getByRole('button', { name: 'Undo' }).click();
    await page.locator('.toast-message', { hasText: `Restored “${spare.title}”` }).waitFor();
    await spareCard.waitFor();
    await spareCard.getByLabel(`Actions for ${spare.title}`, { exact: true }).click();
    await spareCard.getByRole('button', { name: 'Move to trash', exact: true }).click();
    await spareCard.waitFor({ state: 'detached' });
    await page.goto(new URL('/?view=trash', origin).href);
    await page.getByRole('heading', { level: 1, name: 'Trash' }).waitFor();
    await page.getByRole('button', { name: `Restore ${spare.title}`, exact: true }).click();
    await page.locator('.toast-message', { hasText: `Restored “${spare.title}”` }).waitFor();
    assert.equal((await request('/api/v1/workspace')).catalog.boards.some(item => item.id === spare.id), true);

    // Folders: rename and delete never touch workbooks or boards.
    await page.goto(new URL(`/?workbook=${encodeURIComponent(book.id)}`, origin).href);
    await page.getByRole('heading', { name: `Renamed ${suffix}`, exact: true }).waitFor();
    await openNavigation();
    await page.getByLabel(`Actions for folder ${folder.title}`, { exact: true }).click();
    await page.getByRole('button', { name: 'Rename folder…', exact: true }).click();
    await page.getByRole('dialog', { name: 'Rename folder' }).getByLabel('Folder name').fill(`Tidied ${suffix}`);
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await page.locator('.toast-message', { hasText: 'Folder renamed' }).waitFor();
    await openNavigation();
    const folderMenu = page.getByLabel(`Actions for folder Tidied ${suffix}`, { exact: true });
    await folderMenu.click();
    // The floating menu sits at its button (it follows the list), not offset or clipped by it.
    await page.waitForFunction(() => {
      const details = document.querySelector('.folder-menu[open]');
      const anchor = details?.querySelector(':scope > summary')?.getBoundingClientRect();
      const menu = details?.querySelector('.sidebar-add-popover')?.getBoundingClientRect();
      return anchor && menu && (Math.abs(menu.top - (anchor.bottom + 4)) < 3 || Math.abs(menu.bottom - (anchor.top - 4)) < 3);
    }, undefined, { timeout: 3000 });
    // Deleting a folder deletes nothing else, so it asks nothing; Undo re-files its workbooks.
    await page.getByRole('button', { name: 'Delete folder', exact: true }).click();
    await page.locator('.toast-message', { hasText: `Deleted “Tidied ${suffix}”. 1 workbook is now unfiled.` }).getByRole('button', { name: 'Undo' }).click();
    await page.locator('.toast-message', { hasText: `Restored “Tidied ${suffix}”` }).waitFor();
    catalog = (await request('/api/v1/workspace')).catalog;
    assert.equal(catalog.workbooks.find(item => item.id === book.id).folderId, folder.id, 'Undo re-files the workbook');
    await openNavigation();
    await page.getByLabel(`Actions for folder Tidied ${suffix}`, { exact: true }).click();
    await page.getByRole('button', { name: 'Delete folder', exact: true }).click();
    await page.locator('.toast-message', { hasText: `Deleted “Tidied ${suffix}”` }).waitFor();
    catalog = (await request('/api/v1/workspace')).catalog;
    assert.equal(catalog.folders.some(item => item.id === folder.id), false);
    assert.equal(catalog.workbooks.find(item => item.id === book.id).folderId, null, 'Workbooks become unfiled');
    assert.equal(catalog.boards.filter(item => item.workbookId === book.id).length >= 2, true, 'Boards are untouched');

    // Deleting a workbook moves it and its boards to the trash, with Undo.
    if (width < 700 && await page.getByRole('button', { name: 'Studio navigation' }).getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Workbook settings', exact: true }).click();
    await page.getByRole('button', { name: 'Delete workbook…', exact: true }).click();
    confirm = page.getByRole('dialog', { name: `Move “Renamed ${suffix}” to the trash?` });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Keep workbook');
    await confirm.getByRole('button', { name: 'Move to trash', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'All boards' }).waitFor();
    await page.locator('.toast-message', { hasText: `Moved “Renamed ${suffix}” and` }).getByRole('button', { name: 'Undo' }).click();
    await page.locator('.toast-message', { hasText: `Restored “Renamed ${suffix}”` }).waitFor();
    assert.equal((await request('/api/v1/workspace')).catalog.boards.some(item => item.id === spare.id), true, 'Undo brings the boards back');

    if (width < 700) {
      // Escape closes the phone drawer from anywhere and returns to its button.
      await page.getByRole('button', { name: 'Studio navigation' }).click();
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('nav-item')), true, 'Opening the drawer moves focus into it');
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('button', { name: 'Studio navigation' }).getAttribute('aria-expanded'), 'false');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Studio navigation');
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Studio overflowed');
    await page.goto(new URL(`/boards/${board.id}`, origin).href);
    await page.locator('.creation-rail').waitFor();
    await page.getByRole('button', { name: 'Add a sticky note', exact: true }).click();
    await page.locator('.editor-canvas').click({ position: { x: width > 700 ? 650 : 190, y: 350 } });
    await page.getByRole('textbox', { name: 'Edit sticky note', exact: true }).waitFor();
    await page.keyboard.type('A clear next step'); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Note color', exact: true }).click();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator(':focus').getAttribute('aria-label'), 'Peach sticky note');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator(':focus').getAttribute('aria-label'), 'Note color');
    await page.getByRole('button', { name: 'Zoom options', exact: true }).click();
    await page.keyboard.press('ArrowDown'); assert.equal(await page.locator(':focus').innerText(), 'Fit selection');
    await page.getByRole('button', { name: 'Text color', exact: true }).click();
    await page.locator('.zoom-menu').waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    await page.locator('[data-testid="edgeless-note-container"]').click({ button: 'right' });
    assert.equal(await page.getByRole('textbox', { name: 'Edit sticky note', exact: true }).count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Canvas overflowed');
    await page.locator('.editor-canvas').focus();
    await page.keyboard.press('Enter');
    const stickyInput = page.getByRole('textbox', { name: 'Edit sticky note', exact: true });
    await stickyInput.waitFor();
    await stickyInput.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await page.getByRole('button', { name: 'Text color', exact: true }).click();
    await page.getByRole('button', { name: 'Red text', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:paragraph').every(paragraph => paragraph.text.toDelta().every(delta => delta.attributes?.color === '#c6392d')));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Note color', exact: true }).click();
    await page.getByRole('button', { name: 'Pink sticky note', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note')[0].props.background.light === '#ffd2df');
    await page.getByRole('button', { name: 'Workshop tools', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Workshop');
    await page.getByRole('button', { name: 'Timer Set a pace and keep a session on track.' }).click();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Timer');
    await page.getByRole('button', { name: 'Start timer', exact: true }).click();
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByRole('button', { name: 'Start timer', exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Timer');
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Workshop tools');
    await page.getByRole('button', { name: 'Comments', exact: true }).click();
    await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('A review comment');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await page.getByText('A review comment', { exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Comment');
    await page.getByRole('button', { name: 'Resolve', exact: true }).click();
    await page.getByText('A review comment', { exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    assert.deepEqual(errors, []);
    await page.goto(new URL('/settings/connections?find=Connection%20checks', origin).href);
    await page.locator('.setting-found', { hasText: 'Connection checks' }).waitFor();
    assert.equal(new URL(page.url()).searchParams.has('find'), false);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Connection checks');
    await context.close();

    console.log(`${theme}/${width}: Studio URLs, workbook settings without folder clobbering, dialog errors, folder memory, card menu keys, duplicate, move picker, live/scoped search, Back, notifications focus, star in place, roving cards, list layout, trash with Undo and restore, folder rename/delete, workbook delete with Undo, drawer Escape, sticky picker, exclusive popovers, zoom keyboard and secondary click passed.`);
  }
} finally { await browser.close(); }
