import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { NativeEnv } from "../src/auth/types";
import {
  godaddyUpdateRoutes,
  godaddyUpdateStatus,
  maintainGoDaddyUpdates,
} from "../src/updates/godaddy";
import { currentRelease } from "../src/updates/build";
import application from "../../../tools/godaddy-deploy/fixtures/application.json";
vi.mock("../src/updates/build", () => ({
  currentRelease: {
    version: "1.2.0",
    commit: "a".repeat(40),
    schema: "b".repeat(64),
    protocol: 1,
    dataFormat: 1,
    security: false,
    notes: "",
  },
}));
const original = { ...currentRelease };
const zip = new TextEncoder().encode("verified test release bytes");
const digest = createHash("sha256").update(zip).digest("hex");
const release = {
  ...original,
  version: "1.2.1",
  commit: "c".repeat(40),
  security: true,
  nodeSha256: digest,
};
const token = "gd_pat_disposable_test_token";
function adapter(db: DatabaseSync): D1Database {
  function prepare(sql: string, args: SQLInputValue[] = []): any {
    const execute = () => ({
      success: true,
      results: db.prepare(sql).all(...args),
      meta: db.prepare("SELECT changes() AS changes").get(),
    });
    return {
      bind: (...values: SQLInputValue[]) => prepare(sql, values),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => execute(),
      run: async () => execute(),
      execute,
    };
  }
  return {
    prepare,
    batch: async (statements: any[]) => {
      db.exec("BEGIN");
      try {
        const result = statements.map((s) => s.execute());
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
}
describe("GoDaddy durable updates", () => {
  let db: DatabaseSync, env: NativeEnv;
  let uploadLost = false,
    publishLost = false,
    deploymentStatus = "COMPLETED",
    importStatus = "COMPLETED",
    githubDown = false,
    providerStatus = 200,
    corrupt = false;
  let requests: { url: string; init: RequestInit }[];
  beforeEach(() => {
    Object.assign(currentRelease, original);
    db = new DatabaseSync(":memory:");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(new URL(file, directory), "utf8"));
    env = {
      CATALOG: adapter(db),
      HOSTING_PLATFORM: "godaddy",
      NODE_UPDATES_ENABLED: true,
      GODADDY_APP_ID: "NODEJS-test",
      GODADDY_VARIANT: "PUBLISH",
      AUTH_ORIGIN: "https://test.c39.airoapp.ai",
      AUTH_ENCRYPTION_KEYS: JSON.stringify([
        { id: "test", key: Buffer.alloc(32, 7).toString("base64url") },
      ]),
    };
    requests = [];
    uploadLost = false;
    publishLost = false;
    deploymentStatus = "COMPLETED";
    importStatus = "COMPLETED";
    githubDown = false;
    providerStatus = 200;
    corrupt = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.startsWith("https://api.godaddy.com/")) {
          expect(new Headers(init.headers).get("Authorization")).toBe(
            `Bearer ${token}`,
          );
          expect(init.redirect).toBe("manual");
          if (providerStatus !== 200)
            return new Response("PRIVATE PROVIDER ERROR", {
              status: providerStatus,
            });
          if (url.endsWith("/apps/NODEJS-test"))
            return Response.json({
              ...application,
              urls: { ...application.urls, publish: env.AUTH_ORIGIN },
            });
          if (url.endsWith("/imports")) {
            if (uploadLost) {
              uploadLost = false;
              throw new Error("Lost response");
            }
            return Response.json({ importId: "import-one" });
          }
          if (url.endsWith("/imports/import-one"))
            return Response.json({ status: importStatus });
          if (url.endsWith("/deployments")) {
            if (publishLost) {
              publishLost = false;
              throw new Error("Lost response");
            }
            return Response.json({ deploymentId: "deploy-one" });
          }
          if (url.endsWith("/deployments/deploy-one"))
            return Response.json({ status: deploymentStatus });
          throw new Error("Unexpected hosting endpoint");
        }
        expect(new Headers(init.headers).has("Authorization")).toBe(false);
        expect(
          url.startsWith(
            "https://api.github.com/repositories/1404455583/releases/",
          ),
        ).toBe(true);
        if (githubDown) return new Response("Unavailable", { status: 503 });
        if (url.endsWith("/assets/123")) return Response.json(release);
        if (url.endsWith("/assets/456"))
          return new Response(corrupt ? "tampered" : zip);
        return Response.json({
          tag_name: "v1.2.1",
          draft: false,
          prerelease: false,
          assets: [
            { id: 123, name: "huddle-loom-release.json", size: 600 },
            {
              id: 456,
              name: "open-whiteboard-node.zip",
              size: zip.length,
              digest: `sha256:${digest}`,
            },
          ],
        });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });
  async function route(action: string, data: unknown = {}) {
    return godaddyUpdateRoutes(
      new Request(
        `https://test.c39.airoapp.ai/api/v1/admin/updates/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      ),
      env,
      null as unknown as string,
    );
  }
  async function connect() {
    await route("connection", { token });
  }
  async function start() {
    await connect();
    await route("install", { version: release.version });
  }
  function row() {
    return db.prepare("SELECT * FROM software_updates LIMIT 1").get() as any;
  }
  function expireStep() {
    const cp = JSON.parse(row().checkpoint);
    cp.stepStartedAt = Date.now() - 21 * 60_000;
    db.prepare("UPDATE software_updates SET checkpoint=?").run(JSON.stringify(cp));
  }
  function resetBackoff() {
    const cp = JSON.parse(row().checkpoint);
    delete cp.nextAttemptAt;
    db.prepare("UPDATE software_updates SET checkpoint=?").run(
      JSON.stringify(cp),
    );
  }
  async function steps(count: number) {
    for (let i = 0; i < count; i++) await maintainGoDaddyUpdates(env);
  }
  it("encrypts the token, verifies the application origin and omits credentials from status", async () => {
    await connect();
    expect((await godaddyUpdateStatus(env)).connected).toBe(true);
    expect(
      JSON.stringify(
        db.prepare("SELECT * FROM software_update_settings").get(),
      ),
    ).not.toContain(token);
    expect(JSON.stringify(await godaddyUpdateStatus(env))).not.toContain(token);
    expect(requests.filter((r) => r.url.includes("godaddy")).length).toBe(1);
  });
  it("rejects another application and a preview connection", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        id: "NODEJS-another",
        appType: "NODEJS",
        urls: { publish: "https://another.c39.airoapp.ai" },
      }),
    );
    await expect(connect()).rejects.toThrow("must match");
    env.GODADDY_VARIANT = "PREVIEW";
    await expect(connect()).rejects.toThrow("Preview");
    expect((await godaddyUpdateStatus(env)).connected).toBe(false);
  });
  it("connects a custom domain using the server-configured app identity", async () => {
    env.AUTH_ORIGIN = "https://board.example.test";
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      id: "NODEJS-test", appType: "NODEJS", urls: { publish: "https://test.c39.airoapp.ai" },
    }));
    await connect();
    expect((await godaddyUpdateStatus(env)).connected).toBe(true);
    env.AUTH_ORIGIN = "https://changed.example.test";
    expect((await godaddyUpdateStatus(env)).connected).toBe(false);
  });
  it("cannot override the configured app even with a valid provider response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      id: "NODEJS-another", appType: "NODEJS", urls: { publish: env.AUTH_ORIGIN },
    }));
    await expect(route("connection", { token, appId: "NODEJS-another" })).rejects.toThrow("must match");
    expect((await godaddyUpdateStatus(env)).connected).toBe(false);
  });
  it("requires the published origin for legacy installs without a configured app ID", async () => {
    delete env.GODADDY_APP_ID;
    await route("connection", { token, appId: "NODEJS-test" });
    expect((await godaddyUpdateStatus(env)).connected).toBe(true);
    env.AUTH_ORIGIN = "https://custom.example.test";
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      id: "NODEJS-test", appType: "NODEJS", urls: { publish: "https://test.c39.airoapp.ai" },
    }));
    await expect(route("connection", { token, appId: "NODEJS-test" })).rejects.toThrow("must match");
  });
  it.each([
    { appType: "NODEJS", urls: { publish: "https://test.c39.airoapp.ai" } },
    { id: "NODEJS-test", appType: "OTHER", urls: { publish: "https://test.c39.airoapp.ai" } },
  ])("rejects missing provider identity or the wrong app type", async app => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(app));
    await expect(connect()).rejects.toThrow("must match");
  });
  it("requires both a completed provider job and the approved running build", async () => {
    await start();
    await steps(3);
    expect(row().status).toBe("verifying");
    await steps(1);
    expect(row().status).toBe("verifying");
    Object.assign(currentRelease, release);
    deploymentStatus = "PENDING";
    await steps(1);
    expect(row().status).toBe("verifying");
    deploymentStatus = "COMPLETED";
    await steps(1);
    expect(row().status).toBe("succeeded");
    expect(
      requests
        .filter((r) =>
          ["POST", "PUT", "PATCH", "DELETE"].includes(r.init.method ?? ""),
        )
        .map((r) => new URL(r.url).pathname),
    ).toEqual([
      "/v1/hosting/apps/NODEJS-test/imports",
      "/v1/hosting/apps/NODEJS-test/deployments",
    ]);
    expect(JSON.stringify(await godaddyUpdateStatus(env))).not.toContain(
      "uploadKey",
    );
  });
  it("replays an upload with identical bytes and idempotency key after a lost response", async () => {
    await start();
    await steps(1);
    uploadLost = true;
    await steps(1);
    expect(row().message).toContain("retried safely");
    await steps(1);
    expect(requests.filter((r) => r.url.endsWith("/imports"))).toHaveLength(1);
    resetBackoff();
    await steps(1);
    const calls = requests.filter((r) => r.url.endsWith("/imports"));
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0].init.headers).get("Idempotency-Key")).toBe(
      new Headers(calls[1].init.headers).get("Idempotency-Key"),
    );
    expect(await (calls[0].init.body as Blob).text()).toBe(
      await (calls[1].init.body as Blob).text(),
    );
  });
  it("replays publication safely after interruption without creating another upload", async () => {
    await start();
    await steps(2);
    publishLost = true;
    await steps(1);
    resetBackoff();
    await steps(1);
    const calls = requests.filter((r) => r.url.endsWith("/deployments"));
    expect(calls).toHaveLength(2);
    expect(calls[0].init.headers).toEqual(calls[1].init.headers);
    expect(calls.map((r) => r.init.body)).toEqual(["{}", "{}"]);
    expect(requests.filter((r) => r.url.endsWith("/imports"))).toHaveLength(1);
  });
  it("rejects a corrupted package before uploading or replacing the live app", async () => {
    await start();
    await steps(1);
    corrupt = true;
    await steps(1);
    expect(row().status).toBe("failed");
    expect(requests.some((r) => r.url.endsWith("/imports"))).toBe(false);
  });
  it("stops on provider failure without reporting success even if the target is running", async () => {
    await start();
    await steps(3);
    Object.assign(currentRelease, release);
    deploymentStatus = "FAILED";
    await steps(1);
    expect(row().status).toBe("failed");
  });
  it("pauses on an expired token and resumes the same saved deployment after reconnecting", async () => {
    await start();
    await steps(2);
    providerStatus = 401;
    await steps(1);
    expect(row().status).toBe("uncertain");
    expect(row().message).not.toContain("PRIVATE");
    const id = row().id;
    providerStatus = 200;
    await connect();
    await route("continue", { id });
    await steps(1);
    expect(row().id).toBe(id);
    expect(row().status).toBe("verifying");
  });
  it("does not replay provider writes outside the idempotency retention window", async () => {
    await start();
    db.prepare("UPDATE software_updates SET created_at=?").run(
      Date.now() - 24 * 60 * 60 * 1000,
    );
    await steps(1);
    expect(row().status).toBe("uncertain");
    await expect(route("continue", { id: row().id })).rejects.toThrow(
      "safe retry window",
    );
    expect(requests.some((r) => r.init.method === "POST")).toBe(false);
  });
  it("serializes updates and prevents disconnect while an operation is active", async () => {
    await start();
    await expect(
      route("install", { version: release.version }),
    ).rejects.toThrow("already in progress");
    await expect(route("connection", { disconnect: true })).rejects.toThrow(
      "Finish",
    );
  });
  it("installs eligible security patches only after explicit opt-in and never retries a failed version unattended", async () => {
    await connect();
    await steps(1);
    expect(row()).toBeUndefined();
    await route("policy", { automaticSecurity: true });
    await steps(1);
    expect(row().status).toBe("queued");
    db.prepare("UPDATE software_updates SET status='failed'").run();
    await steps(1);
    expect(
      db.prepare("SELECT count(*) AS n FROM software_updates").get()?.n,
    ).toBe(1);
  });
  it.each([
    { security: false },
    { version: "1.3.0" },
    { schema: "d".repeat(64) },
    { dataFormat: 2 },
    { protocol: 2 },
  ])(
    "leaves incompatible or non-security releases for the owner: %j",
    async (changes) => {
      await connect();
      await route("policy", { automaticSecurity: true });
      db.prepare(
        "UPDATE software_update_settings SET checked_at=?,available_release=?",
      ).run(Date.now(), JSON.stringify({ ...release, ...changes }));
      await steps(1);
      expect(row()).toBeUndefined();
    },
  );
  it("does not run unattended from preview or another hosting platform", async () => {
    await start();
    env.GODADDY_VARIANT = "PREVIEW";
    await steps(3);
    expect(row().status).toBe("queued");
    env.GODADDY_VARIANT = "PUBLISH";
    env.HOSTING_PLATFORM = "node";
    await steps(3);
    expect(row().status).toBe("queued");
  });
  it("disconnects and disables automatic installation without exposing the stored token", async () => {
    await connect();
    await route("policy", { automaticSecurity: true });
    await route("connection", { disconnect: true });
    expect(await godaddyUpdateStatus(env)).toMatchObject({
      connected: false,
      automaticSecurity: false,
    });
    expect(
      db.prepare("SELECT hook_ciphertext FROM software_update_settings").get()
        ?.hook_ciphertext,
    ).toBeNull();
  });
  it("requires owner confirmation to close an uncertain record and never closes a running job", async () => {
    await start();
    await expect(route("resolve", { id: row().id })).rejects.toThrow("Check");
    await expect(
      route("resolve", { id: row().id, confirmedStopped: true }),
    ).rejects.toThrow("progressed");
    db.prepare("UPDATE software_updates SET status='uncertain'").run();
    await route("resolve", { id: row().id, confirmedStopped: true });
    expect(row().status).toBe("failed");
  });
  it("can verify a known deployment after the write retry window without issuing new writes", async () => {
    await start();
    await steps(3);
    db.prepare("UPDATE software_updates SET created_at=?").run(
      Date.now() - 25 * 60 * 60 * 1000,
    );
    Object.assign(currentRelease, release);
    requests.length = 0;
    await steps(1);
    expect(row().status).toBe("succeeded");
    expect(
      requests.every((r) => !r.init.method || r.init.method === "GET"),
    ).toBe(true);
  });
  it("offers recovery instead of waiting forever for a provider job or the wrong running version", async () => {
    await start();
    await steps(3);
    expireStep();
    deploymentStatus = "PENDING";
    await steps(1);
    expect(row().status).toBe("uncertain");
    await route("continue", { id: row().id });
    deploymentStatus = "COMPLETED";
    await steps(1);
    expect(row().status).toBe("verifying");
    expireStep();
    await steps(1);
    expect(row().status).toBe("uncertain");
    // The newly started target verifies itself without another owner click.
    Object.assign(currentRelease, release);
    await steps(1);
    expect(row().status).toBe("succeeded");
  });
  it("bounds transient failures and resumes the saved deployment without publishing again", async () => {
    await start();
    await steps(3);
    providerStatus = 503;
    await steps(1);
    expect(row().status).toBe("verifying");
    expireStep();
    resetBackoff();
    await steps(1);
    expect(row().status).toBe("uncertain");
    expect(row().message).toContain("unreachable");
    providerStatus = 200;
    Object.assign(currentRelease, release);
    requests.length = 0;
    await route("continue", { id: row().id });
    await steps(1);
    expect(row().status).toBe("succeeded");
    expect(requests.every((r) => !r.init.method || r.init.method === "GET")).toBe(true);
  });
  it("gives Continue and each new phase a fresh timeout without renewing write keys", async () => {
    await start(); await steps(2);
    importStatus = "PENDING";
    expireStep(); await steps(1);
    expect(row().status).toBe("uncertain");
    const before = JSON.parse(row().checkpoint);
    await route("continue", { id: row().id });
    await steps(2);
    expect(row().status).toBe("deploying");
    expect(JSON.parse(row().checkpoint).stepStartedAt).toBeGreaterThan(before.stepStartedAt);
    expect(JSON.parse(row().checkpoint).publishKey).toBe(before.publishKey);
    expireStep(); importStatus = "COMPLETED";
    await steps(1);
    deploymentStatus = "PENDING";
    await steps(1);
    expect(row().status).toBe("verifying");
    expect(JSON.parse(row().checkpoint).stepStartedAt).toBeGreaterThan(before.stepStartedAt);
  });
  it("retries a failed release check after fifteen minutes instead of a day", async () => {
    await connect();
    githubDown = true; await steps(1);
    expect(db.prepare("SELECT check_error FROM software_update_settings").get()?.check_error).toBeTruthy();
    requests.length = 0; githubDown = false;
    await steps(1);
    expect(requests).toHaveLength(0);
    db.prepare("UPDATE software_update_settings SET checked_at=?").run(Date.now() - 16 * 60_000);
    await steps(1);
    expect(db.prepare("SELECT check_error FROM software_update_settings").get()?.check_error).toBeNull();
    expect(requests.length).toBeGreaterThan(0);
  });

  it("cancels only an unclaimed queued update and makes no provider writes", async () => {
    await route("connection", { token });
    const queued = await route("install", { version: release.version }).then(r => r.json());
    await route("cancel", { id: queued.id });
    requests.length = 0;
    await maintainGoDaddyUpdates(env);
    expect(requests.filter(r => r.init.method === "POST")).toHaveLength(0);
    expect(db.prepare("SELECT status FROM software_updates WHERE id=?").get(queued.id)?.status).toBe("failed");
  });
  it("cannot cancel a job after the runner claims it", async () => {
    await route("connection", { token });
    const queued = await route("install", { version: release.version }).then(r => r.json());
    await maintainGoDaddyUpdates(env);
    await expect(route("cancel", { id: queued.id })).rejects.toMatchObject({ status: 409 });
  });
  it("returns a reconnect conflict after the canonical origin changes", async () => {
    await route("connection", { token });
    env.AUTH_ORIGIN = "https://moved.example";
    for (const [action, data] of [["policy", { automaticSecurity: true }], ["install", { version: release.version }]] as const)
      await expect(route(action, data)).rejects.toMatchObject({ status: 409, code: "UPDATER_RECONNECT_REQUIRED" });
  });
  it("rejects a ZIP digest that does not match the release manifest", async () => {
    await route("connection", { token });
    const queued = await route("install", { version: release.version }).then(r => r.json());
    db.prepare("UPDATE software_updates SET release=? WHERE id=?").run(JSON.stringify({ ...release, nodeSha256: 'f'.repeat(64) }), queued.id);
    requests.length = 0;
    await maintainGoDaddyUpdates(env);
    expect(db.prepare("SELECT status FROM software_updates WHERE id=?").get(queued.id)?.status).toBe("failed");
    expect(requests.some(r => r.url.startsWith('https://api.godaddy.com'))).toBe(false);
  });

});
