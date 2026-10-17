// Deterministic UI checks; every API request is intercepted, no hosting writes.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const origin = process.env.UI_ORIGIN ?? "http://127.0.0.1:5192";
assert(["127.0.0.1", "localhost"].includes(new URL(origin).hostname));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROMIUM_EXECUTABLE_PATH ??
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
try {
  for (const [name, width, theme] of [
    ["desktop", 1440, "light"],
    ["mobile", 390, "dark"],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height: 1000 },
      colorScheme: theme,
    });
    page.setDefaultTimeout(5000);
    await page.addInitScript(
      (theme) => localStorage.setItem("whiteboard-appearance", theme),
      theme,
    );
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const current = {
      version: "1.2.0",
      commit: "a".repeat(40),
      schema: "b".repeat(64),
      protocol: 1,
      dataFormat: 1,
      security: false,
      notes: "",
    };
    const data = {
      deploymentMode: "godaddy",
      appId: "NODEJS-fixture",
      current,
      available: {
        ...current,
        version: "1.2.1",
        notes: "A compatible security patch.",
      },
      connected: false,
      automaticSecurity: false,
      checkedAt: Date.now(),
      checkError: null,
      updateAvailable: true,
      incompatibility: null,
      history: [],
    };
    let installs = 0,
      continues = 0;
    await page.route("**/api/**", async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (path === "/api/v1/auth/bootstrap")
        return route.fulfill({
          json: {
            mode: "native",
            hostingPlatform: "godaddy",
            configured: true,
            setup: false,
            csrf: "fixture",
            title: "Open Whiteboard",
            user: {
              id: "owner",
              name: "Owner",
              email: "owner",
              color: "#3D4A73",
            },
            account: {
              status: "active",
              role: "owner",
              verified: true,
              needsMfa: false,
              recoveryRequired: false,
              twoFactorEnabled: true,
              assurance: "strong",
              onboarding: 999,
              authVersion: 1,
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            },
          },
        });
      if (path.startsWith("/api/v1/admin/updates") && req.method() === "POST") {
        assert.equal(req.headers()["x-canvas-csrf"], "fixture");
        const body = req.postDataJSON();
        if (path.endsWith("/connection")) {
          if (body.disconnect) {
            data.connected = false;
            data.automaticSecurity = false;
          } else {
            assert.equal(body.appId, "NODEJS-fixture");
            assert.equal(body.token, "ui-only-token");
            data.connected = true;
          }
        }
        if (path.endsWith("/policy"))
          data.automaticSecurity = body.automaticSecurity;
        if (path.endsWith("/install")) {
          installs++;
          data.history = [
            {
              id: "one",
              version: "1.2.1",
              status: "queued",
              created_at: Date.now(),
              updated_at: Date.now(),
            },
          ];
        }
        if (path.endsWith("/continue")) {
          continues++;
          data.history[0].status = "verifying";
        }
        if (path.endsWith("/resolve")) {
          assert.equal(body.confirmedStopped, true);
          data.history[0].status = "failed";
        }
      }
      return route.fulfill({
        json: path.startsWith("/api/v1/admin/updates")
          ? data
          : { boards: [], folders: [], workbooks: [], workspaces: [] },
      });
    });
    await page.goto(origin + "/settings/updates");
    await page.getByRole("heading", { name: "Studio updates" }).waitFor();
    assert(
      await page
        .getByRole("button", { name: "Update now", exact: true })
        .isDisabled(),
    );
    await page
      .getByRole("button", { name: "Connect updates", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("GoDaddy app ID", { exact: true }).count(),
      0,
    );
    assert(
      await page
        .getByRole("link", { name: "GoDaddy’s token page" })
        .isVisible(),
    );
    await page
      .getByLabel("Update token", { exact: true })
      .fill("ui-only-token");
    await page.screenshot({ path: `/tmp/godaddy-update-${name}-connect.png` });
    await page
      .getByRole("button", { name: "Connect updates", exact: true })
      .last()
      .click();
    await page.getByText("Updates connected.", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Update token", { exact: true }).count(),
      0,
    );
    await page
      .getByRole("checkbox", {
        name: "Install compatible security patches automatically",
      })
      .check();
    await page.getByText("Changes saved.", { exact: true }).waitFor();
    assert(data.automaticSecurity);
    assert.equal(
      await page.evaluate(() =>
        Object.values(localStorage).some((v) => v.includes("ui-only-token")),
      ),
      false,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
    );
    await page.screenshot({ path: `/tmp/godaddy-update-${name}.png` });
    await page.getByRole("button", { name: "Update now", exact: true }).click();
    await page
      .getByText("Version 1.2.1 · Update scheduled", { exact: true })
      .waitFor();
    assert.equal(installs, 1);
    assert(
      await page
        .getByRole("button", { name: "Disconnect updates", exact: true })
        .isDisabled(),
    );
    data.history[0].status = "uncertain";
    await page.reload();
    await page
      .getByRole("button", { name: "Continue update", exact: true })
      .click();
    await page
      .getByText("Version 1.2.1 · Checking the new version", { exact: true })
      .waitFor();
    assert.equal(continues, 1);
    data.history[0].status = "uncertain";
    await page.reload();
    await page.getByText("Still stuck?", { exact: true }).click();
    assert(
      await page
        .getByRole("button", { name: "Close this update record" })
        .isDisabled(),
    );
    await page
      .getByRole("checkbox", {
        name: "I checked GoDaddy: the deployment is finished or stopped.",
      })
      .check();
    await page
      .getByRole("button", { name: "Close this update record" })
      .click();
    await page
      .getByText("Deployment record closed.", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Disconnect updates", exact: true })
      .click();
    await page
      .getByText("Connect GoDaddy once to update from here.", { exact: true })
      .waitFor();
    assert.equal(data.automaticSecurity, false);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "GoDaddy update UI passed: connection guidance, prefilled app, credential clearing, opt-in, manual install, recovery confirmation, disconnect, mobile and desktop.",
  );
} finally {
  await browser.close();
}
