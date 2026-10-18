// Local browser fixture; all requests are intercepted and no live policy changes.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const origin = process.env.UI_ORIGIN ?? "http://127.0.0.1:5300";
assert(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
await mkdir("/tmp/huddle-verification-policy", { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined) });
try {
  for (const [theme, width] of [["light", 1440], ["dark", 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme });
    await context.addInitScript(theme => localStorage.setItem("whiteboard-appearance", theme), theme);
    const settings = { title: "Open Whiteboard", registration: "invite", approval_required: 0, mfa_required: 0, magic_link: 0, dynamic_registration: 0, reauthentication_seconds: 1800, session_idle_seconds: 604800, session_absolute_seconds: 2592000 };
    Object.assign(settings, { member_limit: 100, guest_limit: 50, board_limit: 200, storage_limit: 10737418240, user_board_limit: 50, user_storage_limit: 1073741824, mail_limit: 1000 });
    const writes = [], failures = [];
    let failNext = null;
    await context.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      if (path === "/api/v1/auth/bootstrap") return route.fulfill({ json: { mode: "native", configured: true, setup: false, csrf: "fixture", cacheNamespace: "policy-fixture", user: { id: "owner", name: "Alex", email: "alex@example.test", color: "#3D4A73" }, account: { status: "active", role: "owner", verified: true, needsMfa: false, recoveryRequired: false, onboarding: 999, authVersion: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() } } });
      if (path === "/api/v1/workspace") return route.fulfill({ json: { catalog: { boards: [], folders: [], workbooks: [] }, user: { name: "Alex", email: "alex@example.test", color: "#3D4A73" }, workspace: { canCreate: true, owner: true }, notifications: { notifications: [] } } });
      if (path === "/api/v1/admin/settings") {
        if (request.method() === "PATCH") {
          // Real error responses from admin/routes.ts.
          if (failNext) { const failure = failNext; failNext = null; return route.fulfill({ status: failure.status, json: { error: failure.error, code: failure.code } }); }
          const body = request.postDataJSON(); writes.push(body); Object.assign(settings, body); return route.fulfill({ json: { saved: true } });
        }
        return route.fulfill({ json: { settings, mailReady: false, providers: { providers: [], callbacks: {}, allowedOidcOrigins: [] } } });
      }
      if (path === "/api/v1/admin/usage") return route.fulfill({ json: { limits: settings, usage: { boards: 2, referencedStorageBytes: 0, mailToday: 0, accounts: [] } } });
      if (path === "/api/v1/admin/people") {
        const second = new URL(request.url()).searchParams.get('after') === 'second';
        const name = second ? 'Riley' : 'Casey';
        return route.fulfill({ json: { people: [{ id: name.toLowerCase(), name, email: `${name.toLowerCase()}@example.test`, role: 'member', status: 'active', verified: 1, twoFactorEnabled: 0, createdAt: '2026-01-01T00:00:00Z' }], next: second ? 'third' : 'second' } });
      }
      if (path === "/api/v1/admin/local-invitations") return route.fulfill({ json: { invitations: [] } });
      if (path === "/api/v1/admin/recipients") return route.fulfill({ json: { people: [] } });
      if (path === "/api/v1/admin/owner-transfer") return route.fulfill({ json: { transfers: [] } });
      if (path === "/api/v1/account/security") return route.fulfill({ json: { user: { id: "owner", name: "Alex", email: "alex@example.test", color: "#3D4A73" }, role: "owner", status: "active", verified: true, emailVerified: true, twoFactorEnabled: true, recoveryRequired: false, methods: [{ id: "m1", providerId: "credential" }], passkeys: [], sessions: [], events: [] } });
      return route.fulfill({ json: { notice: null } });
    });
    const page = await context.newPage(); page.on("pageerror", error => failures.push(error.message));
    const focused = () => page.evaluate(() => { const element = document.activeElement; return !element || element === document.body ? "BODY" : element.matches("input, select, textarea") ? element.tagName : element.textContent?.trim() || element.getAttribute("aria-label"); });
    const bar = () => page.locator(".settings-save-bar").innerText();
    const savePolicy = page.getByRole("button", { name: /^(Save policy|Saving…)$/ });
    await page.goto(origin + "/settings/sign-in");
    const select = page.getByLabel("Ask again for protected changes after");
    await select.waitFor({ timeout: 10000 }).catch(async error => { await page.screenshot({ path: "/tmp/huddle-policy-failure.png" }); console.log(await page.locator("body").innerText(), failures); throw error; }); assert.equal(await select.inputValue(), "1800");
    assert.equal(await select.locator("option").count(), 6);
    // Save stays focusable (aria-disabled) so focus never drops to the page.
    assert.equal(await savePolicy.getAttribute("aria-disabled"), "true");
    await page.getByLabel('Installation name').fill('Unsaved name');
    await page.getByText('You have unsaved changes', { exact: true }).waitFor();
    // Every in-app link gets the same in-app confirmation, not a browser dialog.
    page.on("dialog", dialog => { failures.push(`Unexpected browser dialog: ${dialog.message()}`); void dialog.dismiss(); });
    for (const link of [page.locator('.identity-brand'), page.locator('.identity-back-link'), ...(width > 740 ? [page.locator('.identity-nav a', { hasText: 'Usage and limits' })] : [])]) {
      await link.click();
      await page.getByRole('alertdialog', { name: 'Discard unsaved changes?' }).waitFor();
      assert.equal(await focused(), 'Keep editing');
      await page.getByRole('button', { name: 'Keep editing' }).click();
      assert(new URL(page.url()).pathname === '/settings/sign-in');
      assert.equal(await page.getByLabel('Installation name').inputValue(), 'Unsaved name');
    }
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    assert.equal(await page.getByLabel('Installation name').inputValue(), 'Open Whiteboard');
    assert.equal(await focused(), 'INPUT', 'Discard should return focus to the form');
    assert.equal(await savePolicy.getAttribute("aria-disabled"), "true");
    // Search matches topics as well as titles; Enter opens the first match.
    const search = page.getByRole('searchbox', { name: 'Find settings' });
    for (const [query, expected] of [['usage', 'Usage and limits'], ['password', 'Sign-in settings'], ['invite', 'Invitations'], ['mfa', 'Account and security'], ['email', 'System']]) {
      await search.fill(query);
      const results = await page.locator('#settings-search-results a').allInnerTexts();
      assert(results.some(item => item.includes(expected)), `"${query}" should find ${expected}: ${results}`);
    }
    await search.fill('usage'); await search.press('ArrowDown');
    assert.match(await focused(), /^Usage and limits/);
    await search.fill('');
    if (width > 740) {
      // Enter opens the first result and goes to the setting itself.
      // "mfa" offers the policy first for an owner, and lands on its control.
      await search.fill('mfa'); await search.press('Enter');
      await page.waitForFunction(() => document.querySelector('.setting-found') !== null);
      assert.match(await page.locator('.setting-found').innerText(), /second factor/i);
      assert.equal(await page.evaluate(() => document.activeElement?.closest('.identity-check')?.textContent?.includes('Require a second factor') ?? false), true);
      await search.fill('authenticator'); await search.press('Enter');
      await page.waitForURL(url => new URL(url).pathname === '/settings/account');
      await page.waitForFunction(() => document.querySelector('.setting-found') !== null);
      assert.match(await page.locator('.setting-found').innerText(), /Authenticator/i);
      assert.notEqual(await focused(), 'BODY', 'Search should move focus to the setting');
      assert.equal(new URL(page.url()).searchParams.get('find'), null);
      // Personal and policy settings with the same name are both offered, labelled.
      await search.fill('two-factor');
      assert.deepEqual((await page.locator('#settings-search-results a.setting-result').allInnerTexts()).map(text => text.replace(/\s+/gu, ' ').replace(' ↵', '').trim()), ['Sign-in policy Require a second factor', 'Your account Authenticator app']);
      // Every searchable term lands on a real control.
      await search.fill('delete account'); await search.press('Enter');
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Delete account');
      await search.fill('theme'); await search.press('Enter');
      await page.locator('.identity-header .theme-menu[open]').waitFor();
      await page.keyboard.press('Escape');
      await page.goto(origin + "/settings/sign-in"); await select.waitFor();
    }
    // A failed save explains itself in the bar, keeps the edits and keeps focus.
    await page.getByRole('checkbox', { name: /^Allow email sign-in links/ }).check();
    failNext = { status: 409, error: 'Configure email before enabling magic links.', code: 'MAIL_REQUIRED' };
    await savePolicy.click();
    await page.locator('.settings-save-bar [role="alert"]', { hasText: 'Configure email before enabling magic links.' }).waitFor();
    // The failure points at the field it is about.
    const magicLinks = page.getByRole('checkbox', { name: /^Allow email sign-in links/ });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-invalid') === 'true');
    assert.equal(await magicLinks.getAttribute('aria-invalid'), 'true');
    assert(await magicLinks.isChecked());
    await magicLinks.uncheck();
    await select.selectOption("3600"); await savePolicy.click();
    await page.locator('.settings-save-bar [role="status"]', { hasText: 'Policy saved.' }).waitFor();
    assert.match(await focused(), /^Save policy$/);
    assert.equal(writes.length, 1); assert.equal(writes[0].reauthentication_seconds, 3600); assert.equal(writes[0].session_idle_seconds, 604800);
    assert.equal(await savePolicy.getAttribute("aria-disabled"), "true");
    // A stale success message never sits beside new unsaved edits.
    await page.getByLabel('Installation name').fill('Edited again');
    assert.equal(await page.getByText('Policy saved.').count(), 0);
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.reload(); await select.waitFor(); assert.equal(await select.inputValue(), "3600");
    await select.scrollIntoViewIfNeeded();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Policy page must fit the viewport");
    await page.screenshot({ path: `/tmp/huddle-verification-policy/${theme}.png` });
    // Leaving through the guard discards and navigates.
    await page.getByLabel('Installation name').fill('Leaving');
    await page.locator('.identity-back-link').click();
    await page.getByRole('button', { name: 'Discard and leave' }).click();
    await page.waitForURL(url => new URL(url).pathname === '/');
    await page.goto(origin + '/settings/usage');
    const saveLimits = page.getByRole('button', { name: /^(Save limits|Saving…)$/ });
    await saveLimits.waitFor();
    assert.equal(await saveLimits.getAttribute("aria-disabled"), "true");
    await page.getByLabel('Members', { exact: true }).fill('200');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    assert.equal(await page.getByLabel('Members', { exact: true }).inputValue(), '100');
    await page.getByLabel('Members', { exact: true }).fill('0');
    failNext = { status: 400, error: 'A limit is outside the supported range.', code: 'INVALID_INPUT' };
    await saveLimits.click();
    await page.locator('.settings-save-bar [role="alert"]', { hasText: 'A limit is outside the supported range.' }).waitFor();
    // The out-of-range limit is marked and focused.
    await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'member_limit' && document.activeElement.getAttribute('aria-invalid') === 'true');
    await page.getByLabel('Members', { exact: true }).fill('200');
    await saveLimits.click();
    await page.locator('.settings-save-bar [role="status"]', { hasText: 'Limits saved.' }).waitFor();
    assert.equal(writes.length, 2); assert.equal(writes[1].member_limit, 200);
    assert.equal(writes[1].title, undefined, 'Limits form sent unrelated policy fields');
    assert.equal(await saveLimits.getAttribute("aria-disabled"), "true");
    // Bulk actions apply to the visible page, and changing pages clears selection.
    await page.goto(origin + '/settings/people');
    await page.getByLabel('Select Casey', { exact: true }).check();
    await page.locator('.bulk-action-bar').waitFor();
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await page.getByLabel('Select Riley', { exact: true }).waitFor();
    assert.equal(await page.locator('.bulk-action-bar').count(), 0, 'Next page kept an off-page selection');
    await page.getByLabel('Select Riley', { exact: true }).check();
    await page.getByRole('button', { name: 'First page', exact: true }).click();
    await page.getByLabel('Select Casey', { exact: true }).waitFor();
    assert.equal(await page.locator('.bulk-action-bar').count(), 0, 'First page kept an off-page selection');
    assert.deepEqual(failures, []); await context.close();
  }
  console.log("Settings UI passed: light/dark/mobile, topic search and keyboard, in-app leave confirmation for every link, dirty/discard/save, failures marked on their field with focus moved there, success in the save bar, search that lands on the setting, policy and limit payloads, reload.");
} finally { await browser.close(); }
