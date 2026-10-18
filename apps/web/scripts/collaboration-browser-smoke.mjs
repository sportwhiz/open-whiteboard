import { waitForAsync } from './browser-wait.mjs';
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
const focused = page => page.evaluate(() => {
  const element = document.activeElement;
  return element === document.body || !element ? 'body' : element.getAttribute('aria-label') || element.textContent.trim().slice(0, 60);
});
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
/** Workshop and comment flows that must keep focus where people are working. */
async function workshop(owner, peer, path) {
  const ownerRequest = owner.context().request;
  // Following shows its state in People, and Escape stops it.
  if (!await peer.locator('.collaboration-panel').count()) await peer.getByRole('button', { name: '2 people online', exact: true }).click();
  await peer.getByRole('button', { name: /^Follow / }).click();
  await peer.getByRole('button', { name: /^Following .*Stop following$/ }).waitFor();
  await peer.keyboard.press('Escape');
  assert.equal(await peer.locator('.collaboration-panel').count(), 0, 'Escape should close the People panel first');
  await peer.locator('.follow-banner').waitFor();
  await peer.keyboard.press('Escape');
  await peer.locator('.follow-banner').waitFor({ state: 'hidden' });

  // Raised hands are visible in the header and the Workshop overview.
  await peer.getByRole('button', { name: /^Workshop tools/ }).click();
  await peer.getByRole('button', { name: /^Reactions and hands/ }).click();
  await peer.getByRole('button', { name: 'Raise my hand' }).click();
  await owner.getByRole('button', { name: /raised hand: .*Open raised hands$/ }).waitFor();
  await owner.getByRole('button', { name: /^Workshop tools/ }).click();
  await owner.getByRole('heading', { name: 'Raised hands' }).waitFor();

  // One clock: the panel and the floating timer always agree.
  await owner.getByRole('button', { name: /^Timer/ }).click();
  await owner.getByRole('button', { name: '3 min' }).click();
  await owner.getByRole('button', { name: 'Start timer' }).click();
  await owner.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  for (let sample = 0; sample < 6; sample += 1) {
    const [panelTime, floatingTime] = await owner.evaluate(() => [document.querySelector('.big-timer')?.textContent, document.querySelector('.board-timer strong')?.textContent]);
    assert.equal(panelTime, floatingTime, 'Panel and floating timer disagree');
    await owner.waitForTimeout(240);
  }
  const timerBox = await owner.locator('.board-timer').boundingBox();
  for (const control of await owner.locator('.canvas-bottom-right button').all()) {
    const box = await control.boundingBox();
    if (box) assert(timerBox.x + timerBox.width <= box.x || box.x + box.width <= timerBox.x || timerBox.y + timerBox.height <= box.y, 'The floating timer covers a canvas control');
  }
  await owner.locator('.board-timer-action').focus(); await owner.keyboard.press('Enter');
  await owner.getByRole('button', { name: 'Resume timer' }).waitFor();
  assert.equal(await focused(owner), 'Resume timer', 'Pausing from the floating timer lost focus');
  await owner.getByRole('button', { name: 'Stop', exact: true }).click();
  await owner.getByRole('button', { name: 'Start timer' }).waitFor();
  // Prefilled settings are not unsent text: one Escape closes the panel.
  await owner.getByRole('spinbutton', { name: 'Duration in minutes' }).focus();
  await owner.keyboard.press('Escape');
  assert.equal(await owner.locator('.collaboration-panel').count(), 0, 'Escape in a settings field should close the panel');
  await owner.getByRole('button', { name: /^Workshop tools/ }).click();

  // Private brainstorming is keyboard friendly and reveals into open space.
  await owner.getByRole('button', { name: /^Private brainstorming/ }).click();
  await owner.getByRole('button', { name: 'Start private brainstorm' }).click();
  await owner.getByRole('textbox', { name: 'Your idea', exact: true }).waitFor();
  // The private-note notice must read later edits, not its first captured text.
  await owner.getByRole('button', { name: 'Close panel' }).click();
  await owner.locator('editor-host').focus();
  await owner.keyboard.press('n'); await owner.keyboard.press('Enter');
  const publicNote = owner.getByRole('textbox', { name: 'Edit sticky note', exact: true });
  await publicNote.pressSequentially('First public text'); await owner.keyboard.press('Escape');
  await owner.getByRole('button', { name: 'Make it private', exact: true }).waitFor();
  await owner.keyboard.press('Enter'); await publicNote.press(`${modifier}+a`); await publicNote.pressSequentially('Later public edits'); await owner.keyboard.press('Escape');
  await owner.getByRole('button', { name: 'Make it private', exact: true }).click();
  await owner.locator('.board-notice', { hasText: 'Moved to your private ideas' }).waitFor();
  const ownState = await request(owner.context(), `/api/v1/boards/${board.id}/collaboration`);
  const moved = ownState.brainstorm.myDrafts.find(draft => draft.text === 'Later public edits');
  assert(moved, 'The private idea lost later edits');
  assert.equal((await request(owner.context(), `/api/v1/boards/${board.id}/semantic`)).board.notes.some(note => note.text === 'Later public edits'), false);
  await request(owner.context(), `/api/v1/boards/${board.id}/collaboration/commands`, 'POST', { action: 'delete_draft', draftId: moved.id, operationId: 'remove-move-regression-draft' });
  await peer.getByRole('button', { name: 'All tools' }).click();
  await peer.getByRole('button', { name: /^Private brainstorming/ }).click();
  const idea = peer.getByRole('textbox', { name: 'Your idea', exact: true });
  await idea.fill('First private idea'); await idea.press(`${modifier}+Enter`);
  await peer.locator('.draft-list article').first().waitFor();
  assert.equal(await focused(peer), 'Your idea', 'Saving an idea should return to the idea field');
  await peer.keyboard.type('Second private idea'); await peer.keyboard.press(`${modifier}+Enter`);
  await peer.waitForFunction(() => document.querySelectorAll('.draft-list article').length === 2);
  await peer.locator('.draft-list article').first().getByRole('button', { name: 'Submit' }).click();
  await peer.locator('.draft-list article').nth(1).getByRole('button', { name: /^Delete/ }).click();
  await peer.waitForFunction(() => document.querySelectorAll('.draft-list article').length === 1);
  assert.notEqual(await focused(peer), 'body', 'Deleting an idea lost focus');
  // Someone still writing: the facilitator is told and confirms; the
  // writer keeps their text and their focus through the reveal.
  await idea.click(); await peer.keyboard.type('Still thinking');
  await owner.locator('.facilitator-status', { hasText: '1 person still writing' }).waitFor();
  // Closing the panel ends writing presence without losing the unsent draft.
  await peer.getByRole('button', { name: 'Close panel' }).click();
  await owner.locator('.facilitator-status', { hasText: '1 person still writing' }).waitFor({ state: 'hidden' });
  await waitForAsync(async () => (await request(owner.context(), `${path}/collaboration`)).brainstorm.writingCount === 0, 'Closing the panel left stale writing presence');
  await peer.getByRole('button', { name: /^Workshop tools/ }).click();
  await peer.getByRole('button', { name: /^Private brainstorming/ }).click();
  await idea.waitFor();
  assert.equal(await idea.inputValue(), 'Still thinking', 'Closing the panel discarded the unsent draft');
  await owner.locator('.facilitator-status', { hasText: '1 person still writing' }).waitFor();
  await idea.focus();
  await owner.getByRole('button', { name: 'Reveal 1 idea' }).click();
  await owner.getByRole('button', { name: 'Reveal now' }).click();
  await owner.getByText('Ideas revealed').waitFor();
  await peer.getByText('Ideas revealed').waitFor();
  assert.equal(await idea.inputValue(), 'Still thinking', 'A reveal discarded text someone was writing');
  assert.equal(await focused(peer), 'Your idea', 'A reveal moved focus away from someone typing');
  await peer.getByRole('button', { name: 'Discard' }).click();
  const semantic = (await (await ownerRequest.fetch(new URL(`${path}/semantic`, origin).href)).json()).board;
  const box = xywh => { const [x, y, w, h] = JSON.parse(xywh); return { x, y, w, h }; };
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const revealed = semantic.frames.find(frame => frame.title === 'Silent brainstorm');
  assert(revealed, 'Revealed ideas need their own frame');
  for (const item of [...semantic.frames.filter(frame => frame !== revealed), ...semantic.notes.filter(note => note.text !== 'First private idea')])
    assert(!overlaps(box(revealed.xywh), box(item.xywh)), `Revealed ideas overlap ${item.title ?? item.text}`);

  // Voting: a vote that reaches the per-idea cap keeps focus on the row.
  await owner.getByRole('button', { name: 'All tools' }).click();
  await owner.getByRole('button', { name: /^Voting/ }).click();
  // A new vote defaults to the ideas just revealed.
  await owner.locator('.vote-sources [aria-pressed="true"]', { hasText: 'Revealed ideas' }).waitFor();
  assert.equal(await owner.locator('.eligible-count').innerText(), '1 selected');
  await owner.getByRole('button', { name: 'Start vote on 1 idea' }).click();
  // The peer sees that something is live (the notice itself is hidden while
  // their Workshop panel is open).
  await peer.locator('.labelled-tool .live-dot').waitFor();
  await peer.getByRole('button', { name: 'All tools' }).click();
  await peer.getByRole('button', { name: /^Voting/ }).click();
  // Only the facilitator ends the vote; other editors can take over.
  assert.equal(await peer.getByRole('button', { name: 'End vote and show results' }).count(), 0);
  await peer.locator('.voting-detail .take-over').getByRole('button', { name: 'Take over facilitation' }).waitFor();
  const plus = peer.getByRole('button', { name: /^Vote for / }).first();
  await plus.focus(); await peer.keyboard.press('Enter');
  await owner.locator('.vote-progress', { hasText: '1 of 2 people voted' }).waitFor();
  await peer.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Remove vote from'));
  await owner.getByRole('button', { name: 'End vote and show results' }).click();
  // The facilitator has not voted: ending asks first.
  await owner.getByText('1 person hasn’t voted yet. End the vote now?').waitFor();
  await owner.getByRole('button', { name: 'End vote', exact: true }).click();
  await peer.getByRole('heading', { name: /^Results/ }).waitFor();
  await peer.waitForTimeout(100);
  assert.notEqual(await focused(peer), 'body', 'Ending a vote remotely dropped the voter’s focus');
  await peer.getByRole('button', { name: 'All tools' }).click();
  await peer.getByRole('button', { name: /^Reactions and hands/ }).click();
  await peer.getByRole('button', { name: 'Lower my hand' }).click();
  await owner.locator('.hands-button').waitFor({ state: 'detached' });

  // Comments: pin to a sticky, type straight away, keep drafts, share links.
  await owner.getByRole('button', { name: /^Comments/ }).click();
  await owner.getByRole('button', { name: 'Pin to canvas' }).click();
  // A sticky in plain view, not under the side panel or board chrome.
  const panelLeft = (await owner.locator('.collaboration-panel').boundingBox()).x;
  let sticky;
  for (const note of await owner.locator('[data-testid="edgeless-note-container"]').all()) {
    const candidate = await note.boundingBox();
    if (candidate && candidate.x > 120 && candidate.x + candidate.width < panelLeft - 20 && candidate.y > 140 && candidate.y + candidate.height < 760) { sticky = candidate; break; }
  }
  assert(sticky, 'No sticky is visible to pin a comment to');
  await owner.mouse.click(sticky.x + sticky.width / 2, sticky.y + sticky.height / 2);
  await owner.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Comment');
  assert.match(await owner.locator('#comment-anchor-label').innerText(), /^On sticky “/);
  await owner.keyboard.type('Pinned feedback for ');
  // @mention picker: type @ and part of a name, choose with Enter.
  const peerName = (await peer.evaluate(() => fetch('/api/v1/me').then(response => response.json()))).user.name;
  await owner.keyboard.type(`@${peerName.slice(0, 5)}`);
  await owner.getByRole('listbox', { name: 'People to mention' }).waitFor();
  await owner.keyboard.press('Enter');
  assert.equal(await owner.getByRole('textbox', { name: 'Comment', exact: true }).inputValue(), `Pinned feedback for @${peerName} `);
  await owner.keyboard.press('Backspace');
  assert.equal(await owner.getByRole('textbox', { name: 'Comment', exact: true }).inputValue(), `Pinned feedback for @${peerName}`);
  // Names that fit the query syntax reopen suggestions after Backspace.
  if (await owner.getByRole('listbox', { name: 'People to mention' }).isVisible()) {
    await owner.keyboard.press('Escape');
    await owner.getByRole('listbox', { name: 'People to mention' }).waitFor({ state: 'detached' });
    assert.equal(await focused(owner), 'Comment', 'Closing suggestions moved focus out of the draft');
  }
  await owner.keyboard.press('Escape');
  assert.equal(await owner.locator('.collaboration-panel').count(), 1, 'Escape discarded a comment draft');
  await owner.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await owner.evaluate(() => document.activeElement?.matches('.panel-heading h2')), true, 'Mention selection stole focus back after Escape');
  await owner.keyboard.press('Escape');
  await owner.locator('.collaboration-panel').waitFor({ state: 'detached' });
  await owner.getByRole('button', { name: /^Comments/ }).click();
  assert.equal(await owner.getByRole('textbox', { name: 'Comment', exact: true }).inputValue(), `Pinned feedback for @${peerName}`, 'The comment draft did not survive closing the panel');
  await owner.getByRole('textbox', { name: 'Comment', exact: true }).press(`${modifier}+Enter`);
  const thread = owner.locator('.comment-thread').first();
  await thread.waitFor();
  // The mentioned person is notified (the server resolves the mention).
  await waitForAsync(async () => (await request(peer.context(), '/api/v1/notifications')).notifications.some(item => item.kind === 'mention' && item.body.includes('Pinned feedback')), 'The mention notification did not arrive');
  // Threads are compact summaries; your new thread opens, and collapses on click.
  assert.match(await thread.locator('.thread-place').innerText(), /On sticky “/);
  assert.equal(await thread.locator('.thread-summary').getAttribute('aria-expanded'), 'true');
  await thread.locator('.thread-summary').click();
  assert.equal(await thread.locator('.thread-summary').getAttribute('aria-expanded'), 'false');
  await thread.locator('.thread-summary').click();
  assert.equal(await thread.locator('.thread-summary').getAttribute('aria-expanded'), 'true');
  const threadId = await thread.getAttribute('id');
  // A copied thread link never carries a URL fragment (guest URLs hold a token).
  await owner.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: origin.origin });
  await thread.locator('.thread-menu > summary').click();
  await thread.getByRole('button', { name: 'Copy link' }).click();
  const copied = new URL(await owner.evaluate(() => navigator.clipboard.readText()));
  assert.equal(copied.searchParams.get('thread'), threadId);
  assert.equal(copied.hash, '', 'Thread links must not include a fragment');
  // Someone who leaves the panel keeps their focus where they put it, even
  // when remote updates re-render the panel (Safari leaves focus on the body).
  await owner.getByRole('textbox', { name: 'Comment', exact: true }).fill('Typing, then leaving');
  await owner.evaluate(() => document.activeElement?.blur());
  if (await peer.locator('.collaboration-panel').count()) await peer.getByRole('button', { name: 'Close panel' }).click();
  await peer.getByRole('button', { name: /^Workshop tools/ }).click();
  await peer.getByRole('button', { name: /^Reactions and hands/ }).click();
  await peer.getByRole('button', { name: 'Raise my hand' }).click();
  await owner.locator('.hands-button').waitFor();
  await owner.waitForTimeout(200);
  assert.equal(await focused(owner), 'body', 'The panel pulled focus back after the user left it');
  await peer.getByRole('button', { name: 'Lower my hand' }).click();
  await peer.getByRole('button', { name: 'Close panel' }).click();
  await owner.getByRole('textbox', { name: 'Comment', exact: true }).fill('');
  await owner.getByRole('button', { name: 'Close panel' }).click();
  await owner.evaluate(id => window.dispatchEvent(new CustomEvent('whiteboard-open-thread', { detail: { threadId: id } })), threadId);
  await owner.locator('.comment-thread.active').waitFor();
  assert.equal(new URL(owner.url()).searchParams.get('thread'), threadId);
  await owner.getByRole('button', { name: 'Close panel' }).click();
  assert.equal(new URL(owner.url()).searchParams.get('thread'), null, 'A closed thread link would reopen on reload');
}
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
  // CPU_THROTTLE=4 reproduces slow CI runners locally.
  if (Number(process.env.CPU_THROTTLE) > 1) for (const page of [owner, peer]) {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU_THROTTLE) });
  }
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
  await peer.waitForFunction(() => document.querySelector('.zoom-value').textContent === '75%');
  await peer.mouse.move(1100, 800); await peer.mouse.wheel(200, 150);
  // The camera is saved on a 200 ms debounce after the last change. Waiting
  // only for the zoom let this read the save from the zoom-out while the
  // wheel pan's save was still pending; it then landed during the unseen-tab
  // check and looked like an overwrite. Wait until the saved camera is the
  // live one.
  await peer.waitForFunction(() => {
    const key = Object.keys(localStorage).find(k => k.startsWith('whiteboard-viewport-v1:'));
    const saved = key && JSON.parse(localStorage[key]);
    const live = window.auditController?.camera();
    return saved && live && Math.abs(saved.zoom - 0.75) < .001 &&
      Math.abs(saved.x - live.x) < .01 && Math.abs(saved.y - live.y) < .01 && Math.abs(saved.zoom - live.zoom) < .0001;
  });
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
  await owner.waitForFunction(() => document.querySelector('.zoom-value').textContent === '125%');
  await peer.getByRole('button', { name: '2 people online', exact: true }).click();
  await peer.getByRole('button', { name: /^Follow / }).click();
  await peer.waitForFunction(() => document.querySelector('.zoom-value').textContent === '125%');
  await peer.waitForTimeout(350); const sent = await peer.evaluate(() => window.presenceSent);
  await peer.waitForTimeout(500);
  assert((await peer.evaluate(() => window.presenceSent)) - sent <= 1, 'Following created a camera/presence feedback loop');
  assert.deepEqual(await view(), ownView, 'Following overwrote the personal camera');
  await peer.reload(); await peer.locator('.creation-rail').waitFor();
  await peer.waitForFunction(() => document.querySelector('.zoom-value').textContent === '75%');
  assert.deepEqual(await view(), ownView);
  for (const gesture of ['toolbar', 'keyboard']) {
    if (!await peer.getByRole('button', { name: /^Follow / }).isVisible())
      await peer.getByRole('button', { name: '2 people online', exact: true }).click();
    await peer.getByRole('button', { name: /^Follow / }).click();
    await peer.locator('.follow-banner').waitFor();
    await peer.waitForFunction(() => document.querySelector('.zoom-value').textContent === '125%');
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
  // The presenter has board-level controls; scrolling stops following; the
  // activity pill offers to join again.
  await owner.locator('.presenter-bar').waitFor();
  await peer.mouse.move(700, 500); await peer.mouse.wheel(0, 240);
  await peer.locator('.follow-banner').waitFor({ state: 'hidden' });
  await peer.locator('.activity-pill', { hasText: 'presenting' }).getByRole('button', { name: /Join/ }).click();
  await peer.locator('.follow-banner').waitFor();
  // Escape alone never ends everyone's presentation; ending asks first.
  await owner.evaluate(() => (document.activeElement)?.blur?.());
  await owner.keyboard.press('Escape'); // closes the Present panel first
  assert.equal(await owner.locator('.collaboration-panel').count(), 0);
  // While something is selected, Escape belongs to the canvas (it clears the
  // selection); with nothing selected, Escape asks before ending. The board
  // decides from the state captured before the canvas handled the key, so this
  // holds however slow the machine is.
  const selection = () => owner.evaluate(() => { const holder = {}; window.dispatchEvent(new CustomEvent('whiteboard-viewport-query', { detail: holder })); return holder.selection?.length ?? 0; });
  const presentedNote = await owner.locator('[data-testid="edgeless-note-container"]').first().boundingBox();
  await owner.mouse.click(presentedNote.x + presentedNote.width / 2, presentedNote.y + presentedNote.height / 2);
  await owner.waitForFunction(() => { const holder = {}; window.dispatchEvent(new CustomEvent('whiteboard-viewport-query', { detail: holder })); return (holder.selection?.length ?? 0) > 0; });
  await owner.keyboard.press('Escape');
  await owner.waitForFunction(() => { const holder = {}; window.dispatchEvent(new CustomEvent('whiteboard-viewport-query', { detail: holder })); return (holder.selection?.length ?? 0) === 0; });
  await owner.waitForTimeout(400);
  assert.equal(await owner.getByRole('button', { name: 'Keep presenting' }).count(), 0, 'Escape that cleared a selection offered to end the presentation');
  assert.equal(await selection(), 0);
  await owner.keyboard.press('Escape');
  await owner.getByRole('button', { name: 'Keep presenting' }).waitFor();
  await owner.getByRole('button', { name: 'Keep presenting' }).click();
  assert.equal(await peer.locator('.follow-banner').count(), 1, 'Escape ended the presentation');
  await owner.locator('.presenter-bar').getByRole('button', { name: 'End', exact: true }).click();
  await owner.getByRole('button', { name: 'End presentation' }).click();
  await peer.locator('.follow-banner').waitFor({ state: 'hidden' });
  await owner.locator('.presenter-bar').waitFor({ state: 'detached' });
  await workshop(owner, peer, path);
  await request(ownerContext, `${path}/collaborators/${peerUser.id}`, 'DELETE');
  await peer.waitForFunction(() => document.querySelector('.editor-canvas')?.inert === true);
  assert(await peer.evaluate(() => document.querySelector('whiteboard-editor').doc.readonly));
  assert.deepEqual(errors, []);
  console.log('Browser collaboration passed: two real roles, simultaneous text, offline merge, font-ready auto-fit and observer undo isolation, final camera publication, no follow feedback loop, saved personal view, presentation with presenter bar, scroll-to-leave and Join, follow state and Escape, raised hands, shared timer clock and focus, private brainstorm keyboard flow, writers protected through reveal and clear reveal placement, vote defaults, progress, facilitator-only controls and vote focus, compact comment threads, pinning, drafts, thread links, and live revocation.');
} finally {
  if (board) await request(ownerContext, `/api/v1/boards/${board.id}/catalog`, 'DELETE').catch(console.error);
  if (workbook) await request(ownerContext, `/api/v1/workbooks/${workbook.id}`, 'DELETE').catch(console.error);
  await browser.close();
}
