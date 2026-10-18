import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "../src/security/primitives";

type BrowserFixture = {
  cookies: Map<string, string>;
  csrf: string;
  call: (
    path: string,
    body?: unknown,
    expected?: number,
    method?: string,
  ) => Promise<any>;
};

/**
 * Private invitation links over HTTP against the native fixture: a lost link
 * is replaced (same label and role; the old link stops working), a replaced
 * or revoked invitation can't be replaced again, and revoking is idempotent.
 * The owner session must be fresh and strong (admin POSTs require step-up).
 * Every invitation it creates is revoked before it returns.
 */
export async function adminConformance(ctx: {
  origin: string;
  owner: BrowserFixture;
  database: DatabaseSync;
}) {
  const { owner, database } = ctx;
  const label = `Admin conformance ${Date.now().toString(36)}`;
  const created: string[] = [];
  const preview = (token: string, expected: number) =>
    owner.call("/api/v1/invitations/preview", { localInvite: token }, expected);
  const listed = async (id: string) =>
    (
      (await owner.call("/api/v1/admin/local-invitations")) as {
        invitations: {
          id: string;
          label: string;
          role: string;
          accepted_by: string | null;
          revoked_at: number | null;
        }[];
      }
    ).invitations.find((item) => item.id === id);
  try {
    const original = (await owner.call("/api/v1/admin/local-invitations", {
      label,
      role: "guest",
    })) as { id: string; token: string };
    created.push(original.id);
    assert.equal((await preview(original.token, 200)).kind, "local");

    // Replace the link: one new pending invitation, the original revoked.
    const replacement = (await owner.call(
      `/api/v1/admin/local-invitations/${original.id}/reissue`,
      {},
      201,
    )) as { id: string; token: string; replaces: string };
    created.push(replacement.id);
    assert.equal(replacement.replaces, original.id);
    assert.notEqual(replacement.id, original.id);
    assert.notEqual(replacement.token, original.token);
    const next = await listed(replacement.id);
    assert.ok(next, "the replacement is listed");
    assert.equal(next.label, label);
    assert.equal(next.role, "guest");
    assert.equal(next.revoked_at, null);
    assert.ok((await listed(original.id))?.revoked_at, "the original is revoked");
    assert.equal(
      (
        database
          .prepare("SELECT token_hash FROM local_invitations WHERE id = ?")
          .get(replacement.id) as { token_hash: string }
      ).token_hash,
      await sha256(replacement.token),
      "only the token hash is stored",
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS n FROM security_audit WHERE action = 'local_invitation.reissued' AND target_id = ?",
          )
          .get(original.id) as { n: number }
      ).n,
      1,
    );
    assert.equal((await preview(original.token, 410)).code, "INVALID_INVITATION");
    assert.equal((await preview(replacement.token, 200)).role, "guest");

    // A replaced (revoked) invitation can't be replaced again.
    const again = await owner.call(
      `/api/v1/admin/local-invitations/${original.id}/reissue`,
      {},
      409,
    );
    assert.equal(again.code, "INVITATION_CONFLICT");
    const missing = await owner.call(
      "/api/v1/admin/local-invitations/admin-conformance-missing/reissue",
      {},
      404,
    );
    assert.equal(missing.code, "NOT_FOUND");

    // Revoking stops the link, and a second revoke is a no-op.
    await owner.call(
      `/api/v1/admin/local-invitations/${replacement.id}/revoke`,
      {},
    );
    await owner.call(
      `/api/v1/admin/local-invitations/${replacement.id}/revoke`,
      {},
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS n FROM security_audit WHERE action = 'local_invitation.revoked' AND target_id = ?",
          )
          .get(replacement.id) as { n: number }
      ).n,
      1,
    );
    assert.equal((await preview(replacement.token, 410)).code, "INVALID_INVITATION");
    const revoked = await owner.call(
      `/api/v1/admin/local-invitations/${replacement.id}/reissue`,
      {},
      409,
    );
    assert.equal(revoked.code, "INVITATION_CONFLICT");

    // The settings page reports how many people a second-factor requirement affects.
    const settings = await owner.call("/api/v1/admin/settings");
    assert.equal(typeof settings.mfaImpact?.withoutSecondFactor, "number");
  } finally {
    // Leave nothing usable behind, even when an assertion failed midway.
    for (const id of created)
      await owner
        .call(`/api/v1/admin/local-invitations/${id}/revoke`, {})
        .catch(() => undefined);
  }
  console.log(
    "Admin invitation link replacement, revocation and MFA impact passed.",
  );
}
