import { randomUUID } from "node:crypto";
import { createPool } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { buildMysqlPoolOptions, MysqlCoordinationStore, type MysqlPool } from "./database";
import { migrateNodeDatabase } from "./migrations";

// Explicit opt-in: never infer production DB_* credentials for conformance tests.
describe.skipIf(!process.env.HUDDLE_TEST_MYSQL_URL)(
  "MySQL 8 coordination conformance",
  () => {
    it("retires idle sockets while retaining a checked-out ownership connection", async () => {
      const url = new URL(process.env.HUDDLE_TEST_MYSQL_URL!);
      const options = buildMysqlPoolOptions({ DB_HOST: url.hostname, DB_PORT: url.port || "3306", DB_NAME: url.pathname.slice(1), DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password), DB_TLS: "disabled" });
      // Shorten only the timeout so this exercises the driver's real idle reaper.
      const pool = createPool({ ...options, idleTimeout: 500 });
      const held = await pool.getConnection();
      const idle = await pool.getConnection();
      const heldId = held.threadId, idleId = idle.threadId;
      const lock = `idle-reaper:${randomUUID()}`;
      try {
        await held.execute("SELECT GET_LOCK(?,0)", [lock]);
        idle.release();
        await new Promise(resolve => setTimeout(resolve, 1600));
        const replacement = await pool.getConnection();
        try { expect(replacement.threadId).not.toBe(idleId); }
        finally { replacement.release(); }
        const [rows] = await held.query("SELECT IS_USED_LOCK(?) AS owner", [lock]);
        expect((rows as { owner: number }[])[0].owner).toBe(heldId);
      } finally {
        await held.execute("SELECT RELEASE_LOCK(?)", [lock]);
        held.release(); await pool.end();
      }
    });
    it("serializes migrations, creates one key, fences competing leases and persists restart state", async () => {
      const pool = createPool(process.env.HUDDLE_TEST_MYSQL_URL!);
      const key = `test:${randomUUID()}`;
      const leaseName = `test:${randomUUID()}`;
      try {
        const adapter = pool as unknown as MysqlPool;
        await Promise.all(
          Array.from({ length: 4 }, () => migrateNodeDatabase(adapter)),
        );
        const store = new MysqlCoordinationStore(adapter);
        const keys = await Promise.all(
          Array.from({ length: 12 }, () => store.getOrCreateSecret(key)),
        );
        expect(new Set(keys.map((value) => value.toString("hex"))).size).toBe(
          1,
        );
        expect(
          await new MysqlCoordinationStore(adapter).readSecret(key),
        ).toEqual(keys[0]);
        const attempts = await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            store.acquireLease(leaseName, `worker:${index}`, 30),
          ),
        );
        const winners = attempts.filter((value) => value !== null);
        expect(winners).toHaveLength(1);
        const first = winners[0]!;
        expect(await store.renewLease(first, 30)).toBe(true);
        await store.releaseLease(first);
        const second = await store.acquireLease(leaseName, "worker:new", 30);
        expect(second).not.toBeNull();
        expect(BigInt(second!.fence)).toBeGreaterThan(BigInt(first.fence));
        expect(await store.renewLease(first, 30)).toBe(false);
        await store.releaseLease(first);
        expect(
          await store.acquireLease(leaseName, "worker:third", 30),
        ).toBeNull();
        await pool.execute(
          "UPDATE hl_node_leases SET expires_at = 0 WHERE name = ?",
          [leaseName],
        );
        expect(await store.renewLease(second!, 30)).toBe(false);
        await pool.execute("DELETE FROM hl_node_secrets WHERE name = ?", [key]);
        await expect(store.readSecret(key)).rejects.toThrow("restore");
      } finally {
        await pool.execute("DELETE FROM hl_node_secrets WHERE name = ?", [key]);
        await pool.execute("DELETE FROM hl_node_leases WHERE name = ?", [
          leaseName,
        ]);
        await pool.end();
      }
    });
  },
);
