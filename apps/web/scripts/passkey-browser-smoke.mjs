// Uses only the isolated local auth fixture and a virtual Chrome authenticator.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

export async function optionalSetupAndPasskey(origin, cookies) {
  assert.equal(new URL(origin).hostname, 'localhost');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, url: origin })));
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    } });
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Protect your account', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await page.getByRole('heading', { name: 'Your studio is ready', exact: true }).waitFor();
    await page.getByText('Add extra protection when you’re ready', { exact: true }).waitFor();
    await page.screenshot({ path: '/tmp/whiteboard-optional-protection.png', fullPage: true });
    const completion = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/setup/complete');
    await page.getByRole('button', { name: 'Open my studio', exact: true }).click();
    assert.equal((await completion).status(), 200);
    await page.goto(origin + '/settings/account');
    const creationOptions = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/passkey/generate-register-options');
    const creation = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/passkey/verify-registration');
    await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
    assert.equal((await (await creationOptions).json()).authenticatorSelection.userVerification, 'required');
    const created = await creation;
    assert.equal(created.status(), 200);
    const passkey = await created.json();
    const signInOptions = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/passkey/generate-authenticate-options');
    // Invoke the same client action used immediately after passkey enrollment.
    await page.evaluate(async () => {
      const { passkeyAction } = await import('/src/auth-ui.tsx');
      await passkeyAction('sign-in');
    });
    assert.equal((await (await signInOptions).json()).userVerification, 'required');
    const bootstrap = await (await context.request.get(origin + '/api/v1/auth/bootstrap')).json();
    assert.equal(bootstrap.account.assurance, 'strong');
    const removed = await context.request.post(origin + '/api/auth/passkey/delete-passkey', {
      headers: { Origin: origin, 'X-Canvas-CSRF': bootstrap.csrf }, data: { id: passkey.id },
    });
    assert.equal(removed.status(), 200, 'An optional owner passkey can be removed when a password remains');
    cookies.clear();
    for (const cookie of await context.cookies(origin)) cookies.set(cookie.name, cookie.value);
    console.log('Chrome passkeys: optional setup completes without MFA; later registration and sign-in request and verify device authentication.');
  } finally { await browser.close(); }
}
