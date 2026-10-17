import { afterEach, describe, expect, it } from "vitest";
import { createNodeHttpServer, staticAssets } from "./http";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { connect } from "node:net";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("Node HTTP bridge", () => {
  it("serves SPA navigation but does not hide missing assets", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "huddle-assets-"));
    dirs.push(root);
    await writeFile(resolve(root, "index.html"), "<h1>Studio</h1>");
    await mkdir(resolve(root, "assets"));
    await writeFile(resolve(root, "assets", "main-abcdef.js"), "ok");
    const assets = await staticAssets(root);
    for (const method of ["GET", "HEAD"]) {
      for (const accept of [undefined, "*/*"]) {
        const response = await assets.fetch(
          new Request("https://studio.test/", {
            method,
            ...(accept ? { headers: { Accept: accept } } : {}),
          }),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toContain("text/html");
        expect(await response.text()).toBe(
          method === "HEAD" ? "" : "<h1>Studio</h1>",
        );
      }
    }
    expect(
      (await assets.fetch(new Request("https://studio.test/missing"))).status,
    ).toBe(404);
    expect(
      (
        await assets.fetch(
          new Request("https://studio.test/boards/one", {
            headers: { Accept: "text/html" },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await assets.fetch(
          new Request("https://studio.test/missing.js", {
            headers: { Accept: "text/html" },
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await assets.fetch(
          new Request("https://studio.test/assets/main-abcdef.js"),
        )
      ).headers.get("Cache-Control"),
    ).toContain("immutable");
  });
  it("rejects foreign hosts, strips forged platform identity, preserves cookies", async () => {
    const host = "studio.example";
    let seen: Request | undefined;
    const runtime = createNodeHttpServer(
      {
        async fetch(req) {
          seen = req;
          const headers = new Headers();
          headers.append("Set-Cookie", "one=1; Path=/");
          headers.append("Set-Cookie", "two=2; Path=/");
          return new Response("ok", { headers });
        },
      },
      `https://${host}`,
    );
    await new Promise<void>((resolve) =>
      runtime.server.listen(0, "127.0.0.1", resolve),
    );
    const address = runtime.server.address() as { port: number };
    const get = (hostname: string, path = "/") =>
      new Promise<{ status: number; cookies: string[] | undefined }>(
        (resolve) => {
          const req = request(
            {
              host: "127.0.0.1",
              port: address.port,
              path,
              headers: {
                Host: hostname,
                "CF-Connecting-IP": "attacker",
                "CF-Access-Jwt-Assertion": "fake",
                "X-Forwarded-Host": "evil.test",
              },
            },
            (response) => {
              response.resume();
              response.on("end", () =>
                resolve({
                  status: response.statusCode!,
                  cookies: response.headers["set-cookie"],
                }),
              );
            },
          );
          req.end();
        },
      );
    try {
      expect((await get("evil.test")).status).toBe(400);
      expect((await get(host, "/\\evil.test/oauth/authorize")).status).toBe(
        400,
      );
      const result = await get(host);
      expect(result.status).toBe(200);
      expect(result.cookies).toHaveLength(2);
      expect(seen!.headers.get("CF-Access-Jwt-Assertion")).toBeNull();
      expect(seen!.headers.get("X-Forwarded-Host")).toBeNull();
      expect(seen!.headers.get("CF-Connecting-IP")).toBe("127.0.0.1");
    } finally {
      await runtime.close();
    }
  });
});

it("survives a client that resets during an upgrade", async () => {
  let entered!: () => void;
  let release!: () => void;
  let upgradeSignal: AbortSignal | undefined;
  const authorizing = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const runtime = createNodeHttpServer(
    {
      async fetch(req) {
        if (new URL(req.url).pathname.endsWith("/ws")) {
          upgradeSignal = req.signal;
          entered();
          await gate;
          return new Response(null, { status: 401 });
        }
        return new Response("ok");
      },
    },
    "https://studio.example",
  );
  await new Promise<void>((resolve) =>
    runtime.server.listen(0, "127.0.0.1", resolve),
  );
  const { port } = runtime.server.address() as { port: number };
  try {
    const client = connect(port, "127.0.0.1");
    client.on("error", () => {});
    client.write(
      "GET /api/v1/boards/board/ws HTTP/1.1\r\nHost: studio.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    await authorizing;
    client.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upgradeSignal?.aborted).toBe(true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = await new Promise<number>((resolve, reject) =>
      request(
        { host: "127.0.0.1", port, headers: { Host: "studio.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      )
        .on("error", reject)
        .end(),
    );
    expect(status).toBe(200);
  } finally {
    await runtime.close();
  }
});

it("closes safely and idempotently when the listener never started", async () => {
  const runtime = createNodeHttpServer(
    { fetch: async () => new Response("ok") },
    "https://studio.example",
  );
  await expect(runtime.close()).resolves.toBeUndefined();
  await expect(runtime.close()).resolves.toBeUndefined();
});

it("serves only readiness to local supervisor probes without weakening application hosts", async () => {
  let ready = false;
  let appRequests = 0;
  const runtime = createNodeHttpServer(
    { fetch: async () => { appRequests++; return new Response("application"); } },
    "https://studio.example",
    { isReady: () => ready },
  );
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const { port } = runtime.server.address() as { port: number };
  const probe = (host: string, path = "/", method = "GET") => new Promise<{ status: number; body: string; cookie: unknown }>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, method, headers: { Host: host, "X-Forwarded-Host": "studio.example", Cookie: "private=unused" } }, response => {
      let body = ""; response.setEncoding("utf8"); response.on("data", chunk => body += chunk);
      response.on("end", () => resolve({ status: response.statusCode!, body, cookie: response.headers['set-cookie'] }));
    }).on("error", reject).end();
  });
  try {
    expect((await probe(`localhost:${port}`)).status).toBe(503);
    ready = true;
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      for (const path of ["/", "/healthz"]) {
        const result = await probe(`${host}:${port}`, path);
        expect(result).toEqual({ status: 200, body: '{"ready":true}', cookie: undefined });
        expect((await probe(`${host}:${port}`, path, "HEAD")).body).toBe("");
      }
    }
    for (const path of ["/api/v1/auth/bootstrap", "/oauth/authorize", "/?probe=1", "/healthz?probe=1"]) expect((await probe(`localhost:${port}`, path)).status).toBe(400);
    expect((await probe(`localhost:${port}`, "/", "POST")).status).toBe(400);
    expect((await probe(`localhost:${port + 1}`)).status).toBe(400);
    expect((await probe("attacker.test")).status).toBe(400);
    expect(appRequests).toBe(0);
    expect((await probe("studio.example")).body).toBe("application");
    expect(appRequests).toBe(1);
    ready = false;
    expect((await probe(`127.0.0.1:${port}`, "/healthz")).status).toBe(503);
  } finally { await runtime.close(); }
});
