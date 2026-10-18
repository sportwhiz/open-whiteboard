import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeEnv } from "../src/auth/types";

// The session and freshness checks are covered elsewhere; here the signed-in
// administrator is a fixture and every statement runs against the real schema.
const { session } = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("../src/auth/session", () => ({ nativePrincipal: session }));
vi.mock("../src/auth/policy", async (original) => {
  const actual = await original<typeof import("../src/auth/policy")>();
  return {
    ...actual,
    requireAdministrator: async (env: NativeEnv, principal: { id: string }) =>
      actual.securityState(env.CATALOG, principal.id),
  };
});
import { adminRoutes } from "../src/admin/routes";
import { sha256 } from "../src/security/primitives";

const migrationDirectory = new URL("../migrations/", import.meta.url);
const origin = "https://studio.example";
const at = new Date().toISOString();

function fixtureDatabase(db: DatabaseSync) {
  const prepare = (sql: string, values: SQLInputValue[] = []) => {
    const execute = () => {
      const results = db.prepare(sql).all(...values);
      const meta = db.prepare("SELECT changes() AS changes").get();
      return { success: true, results, meta: { changes: Number(meta!.changes) } };
    };
    return {
      bind: (...next: SQLInputValue[]) => prepare(sql, next),
      first: async () => db.prepare(sql).get(...values) ?? null,
      all: async () => execute(),
      run: async () => execute(),
      execute,
    };
  };
  return {
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) => {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

describe("administration: invitation links, role changes and MFA impact", () => {
  let db: DatabaseSync;
  let env: NativeEnv;
  const person = (id: string, role: string | null, status = "active", name = id) => {
    db.prepare("INSERT INTO users(id,issuer,subject,email,display_name,color,created_at,updated_at) VALUES (?,'fixture',?,?,?,'#4262ff',?,?)").run(id, id, `${id}@example.invalid`, name, at, at);
    db.prepare("INSERT INTO auth_users(id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled) VALUES (?,?,?,1,?,?,0)").run(id, name, `${id}@example.invalid`, at, at);
    db.prepare("INSERT INTO account_security(user_id,status,created_at,updated_at) VALUES (?,?,?,?)").run(id, status, at, at);
    if (role) db.prepare("INSERT INTO instance_memberships(user_id,role,created_at) VALUES (?,?,?)").run(id, role, at);
  };
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await adminRoutes(
      new Request(`${origin}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
    return response!;
  };
  const invitation = (id: string, label: string, overrides: { expires?: number; accepted?: string; revoked?: number } = {}) =>
    db.prepare("INSERT INTO local_invitations(id,token_hash,label,role,created_by,created_at,expires_at,accepted_by,revoked_at) VALUES (?,?,?,'guest','owner',?,?,?,?)").run(
      id, `hash-${id}`, label, Date.now() - 1000, overrides.expires ?? Date.now() + 86400000, overrides.accepted ?? null, overrides.revoked ?? null,
    );
  const row = (id: string) => db.prepare("SELECT * FROM local_invitations WHERE id = ?").get(id) as Record<string, unknown> | undefined;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort())
      db.exec(readFileSync(new URL(name, migrationDirectory), "utf8"));
    person("owner", "owner", "active", "Olivia");
    db.exec("UPDATE installation SET state = 'ready', owner_id = 'owner'");
    env = { CATALOG: fixtureDatabase(db), AUTH_ORIGIN: origin, AUTH_SECRET: "admin-routes-test-secret" } as NativeEnv;
    session.mockResolvedValue({ principal: { id: "owner", name: "Olivia" }, user: { id: "owner" } });
  });
  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  describe("replacing a private invitation link", () => {
    it("revokes the original and issues a working link with the same label and role", async () => {
      invitation("original", "Vera");
      const response = await call("/api/v1/admin/local-invitations/original/reissue", {});
      expect(response.status).toBe(201);
      const issued = (await response.json()) as { id: string; token: string; replaces: string };
      expect(issued.replaces).toBe("original");
      expect(row("original")!.revoked_at).toEqual(expect.any(Number));
      const replacement = row(issued.id)!;
      expect(replacement).toMatchObject({ label: "Vera", role: "guest", created_by: "owner", accepted_by: null, revoked_at: null });
      expect(replacement.token_hash).toBe(await sha256(issued.token));
      expect(Number(replacement.expires_at)).toBeGreaterThan(Date.now() + 6.9 * 86400000);
      expect(db.prepare("SELECT target_id, metadata FROM security_audit WHERE action = 'local_invitation.reissued'").all()).toEqual([
        { target_id: "original", metadata: '{"role":"guest"}' },
      ]);
    });

    it("can renew an expired invitation", async () => {
      invitation("expired", "Sam", { expires: Date.now() - 1000 });
      const response = await call("/api/v1/admin/local-invitations/expired/reissue", {});
      expect(response.status).toBe(201);
      expect(row("expired")!.revoked_at).not.toBeNull();
    });

    it.each([
      ["accepted", { accepted: "owner" }, "already been accepted"],
      ["revoked", { revoked: Date.now() - 5 }, "was revoked"],
    ] as const)("rejects an %s invitation without changing anything", async (_kind, overrides, message) => {
      invitation("used", "Kim", overrides);
      const before = row("used");
      await expect(call("/api/v1/admin/local-invitations/used/reissue", {})).rejects.toMatchObject({ status: 409, code: "INVITATION_CONFLICT", message: expect.stringContaining(message) });
      expect(row("used")).toEqual(before);
      expect(db.prepare("SELECT COUNT(*) AS n FROM local_invitations").get()!.n).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM security_audit").get()!.n).toBe(0);
    });

    it("reports a missing invitation", async () => {
      await expect(call("/api/v1/admin/local-invitations/missing/reissue", {})).rejects.toMatchObject({ status: 404 });
    });

    it("replaces a link at the 100-invitation limit, since the original stops counting", async () => {
      for (let index = 0; index < 100; index++) invitation(`active-${index}`, `Person ${index}`);
      expect((await call("/api/v1/admin/local-invitations/active-0/reissue", {})).status).toBe(201);
      expect(db.prepare("SELECT COUNT(*) AS n FROM local_invitations WHERE revoked_at IS NULL AND accepted_by IS NULL AND expires_at > ?").get(Date.now())!.n).toBe(100);
    });

    it("keeps the original usable when the replacement would exceed the limit", async () => {
      invitation("expired", "Sam", { expires: Date.now() - 1000 });
      for (let index = 0; index < 100; index++) invitation(`active-${index}`, `Person ${index}`);
      await expect(call("/api/v1/admin/local-invitations/expired/reissue", {})).rejects.toMatchObject({ status: 409, code: "INVITATION_LIMIT" });
      expect(row("expired")!.revoked_at).toBeNull();
      expect(db.prepare("SELECT COUNT(*) AS n FROM local_invitations").get()!.n).toBe(101);
      expect(db.prepare("SELECT COUNT(*) AS n FROM security_audit").get()!.n).toBe(0);
    });

    it("lets only one of two concurrent replacements win", async () => {
      invitation("original", "Vera");
      const results = await Promise.allSettled([
        call("/api/v1/admin/local-invitations/original/reissue", {}),
        call("/api/v1/admin/local-invitations/original/reissue", {}),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM local_invitations WHERE revoked_at IS NULL").get()!.n).toBe(1);
    });

    it("lists usable invitations ahead of their history and audits a revoke once", async () => {
      invitation("old", "Old", { revoked: Date.now() - 10 });
      invitation("pending", "Pending");
      const list = (await (await call("/api/v1/admin/local-invitations")).json()) as { invitations: { id: string }[] };
      expect(list.invitations.map((item) => item.id)).toEqual(["pending", "old"]);
      await call("/api/v1/admin/local-invitations/pending/revoke", {});
      await call("/api/v1/admin/local-invitations/pending/revoke", {});
      expect(db.prepare("SELECT COUNT(*) AS n FROM security_audit WHERE action = 'local_invitation.revoked'").get()!.n).toBe(1);
    });
  });

  describe("changing a Studio role", () => {
    const notifications = () =>
      db.prepare("SELECT user_id, board_id, kind, title, body, href FROM notifications").all();

    it("tells the person why they were signed out when they become an administrator", async () => {
      person("mia", "member", "active", "Mia");
      expect((await call("/api/v1/admin/people/mia/role", { role: "admin", reason: "Team lead" })).status).toBe(200);
      expect(db.prepare("SELECT role FROM instance_memberships WHERE user_id = 'mia'").get()!.role).toBe("admin");
      expect(notifications()).toEqual([{
        user_id: "mia",
        board_id: null,
        kind: "account",
        title: "Your Studio role changed to Administrator",
        body: "Olivia made you an Administrator. You were signed out so the change could take effect.",
        href: "/settings/account",
      }]);
      expect(db.prepare("SELECT auth_version FROM account_security WHERE user_id = 'mia'").get()!.auth_version).toBe(2);
    });

    it("explains the loss of administration and guest access", async () => {
      person("ada", "admin", "active", "Ada");
      person("gus", "member", "active", "Gus");
      await call("/api/v1/admin/people/ada/role", { role: "member" });
      await call("/api/v1/admin/people/gus/role", { role: "guest" });
      const bodies = Object.fromEntries((notifications() as { user_id: string; body: string }[]).map((item) => [item.user_id, item.body]));
      expect(bodies.ada).toBe("Olivia changed your Studio role from Administrator to Member. You no longer have access to Studio administration. You were signed out so the change could take effect.");
      expect(bodies.gus).toContain("from Member to Guest. You can still open the boards and workbooks shared with you.");
    });

    it("changes nothing, and signs nobody out, when the role is unchanged", async () => {
      person("mia", "member");
      expect(await (await call("/api/v1/admin/people/mia/role", { role: "member" })).json()).toEqual({ updated: false });
      expect(notifications()).toEqual([]);
      expect(db.prepare("SELECT auth_version FROM account_security WHERE user_id = 'mia'").get()!.auth_version).toBe(1);
    });

    it("writes no notification when the role change fails", async () => {
      person("pending", null, "pending_approval");
      await expect(call("/api/v1/admin/people/pending/role", { role: "member" })).rejects.toMatchObject({ code: "ADMISSION_REQUIRED" });
      expect(notifications()).toEqual([]);
    });

    it("reports passkeys in the people list", async () => {
      person("mia", "member");
      db.prepare(`INSERT INTO auth_passkeys(id,publicKey,userId,credentialID,counter,deviceType,backedUp) VALUES ('key','pk','mia','cred',0,'singleDevice',0)`).run();
      const people = (await (await call("/api/v1/admin/people")).json()) as { people: { id: string; passkeys: number }[] };
      expect(people.people.find((item) => item.id === "mia")!.passkeys).toBe(1);
    });
  });

  describe("requiring a second factor", () => {
    it("counts active admitted accounts with neither an authenticator nor a passkey", async () => {
      db.exec("UPDATE auth_users SET twoFactorEnabled = 1 WHERE id = 'owner'");
      person("totp", "member");
      db.exec("UPDATE auth_users SET twoFactorEnabled = 1 WHERE id = 'totp'");
      person("passkey", "member");
      db.prepare(`INSERT INTO auth_passkeys(id,publicKey,userId,credentialID,counter,deviceType,backedUp) VALUES ('key','pk','passkey','cred',0,'singleDevice',0)`).run();
      person("none-a", "member");
      person("none-b", "guest");
      person("suspended", "member", "suspended");
      person("waiting", null, "pending_approval");
      const settings = (await (await call("/api/v1/admin/settings")).json()) as { mfaImpact: { withoutSecondFactor: number } };
      expect(settings.mfaImpact).toEqual({ withoutSecondFactor: 2 });
    });
  });
});
