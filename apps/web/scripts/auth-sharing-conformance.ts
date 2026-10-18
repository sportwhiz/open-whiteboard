import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";

type BrowserFixture = {
  cookies: Map<string, string>;
  csrf: string;
  call: (
    path: string,
    body?: unknown,
    expected?: number | number[],
    method?: string,
  ) => Promise<any>;
};

/**
 * Sharing with existing Studio accounts, over HTTP against the native Worker:
 * owners find admitted members by name and share directly; members cannot
 * search a board they do not own. Leaves the member's board access exactly as
 * it found it, so it can run at any point in the native suite.
 */
export async function sharingConformance(ctx: {
  origin: string;
  owner: BrowserFixture;
  member: BrowserFixture;
  board: { id: string };
  database: DatabaseSync;
  memberId: string;
  memberEmail: string;
}) {
  const { owner, member, board, database, memberId, memberEmail } = ctx;
  const base = `/api/v1/boards/${encodeURIComponent(board.id)}`;
  const search = (who: BrowserFixture, q: string, expected: number | number[] = 200) =>
    who.call(`${base}/share/people?q=${encodeURIComponent(q)}`, undefined, expected);
  const startedAt = new Date().toISOString();

  const admitted = database
    .prepare(
      "SELECT u.display_name AS name, s.status, m.role FROM users u JOIN account_security s ON s.user_id = u.id LEFT JOIN instance_memberships m ON m.user_id = u.id WHERE u.id = ?",
    )
    .get(memberId) as { name: string; status: string; role: string | null } | undefined;
  assert.ok(admitted, "sharing conformance: the member account must exist");
  assert.equal(admitted.status, "active", "sharing conformance: run after the member is approved");
  assert.ok(admitted.role && admitted.role !== "guest", "sharing conformance: the member needs a member role");

  // Preserve any access the member already has, then start from none.
  const previous = database
    .prepare(
      "SELECT role, source, expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt FROM resource_grants WHERE resource_type = 'board' AND resource_id = ? AND user_id = ?",
    )
    .get(board.id, memberId) as
    | { role: string; source: string; expiresAt: string | null; createdAt: string; updatedAt: string }
    | undefined;
  assert.notEqual(previous?.role, "owner", "sharing conformance: the member must not own the board");
  if (previous)
    await owner.call(`${base}/collaborators/${encodeURIComponent(memberId)}`, undefined, 200, "DELETE");

  try {
    // Someone without sharing rights learns nothing, not even that the board exists.
    await search(member, admitted.name, [403, 404]);

    // The owner finds the member by display name, not only by exact username or email.
    const found = (await search(owner, admitted.name)).people as any[];
    const person = found.find((item) => item.id === memberId);
    assert.ok(person, `owner search for "${admitted.name}" should find the member`);
    assert.equal(person.handle.toLowerCase(), memberEmail.toLowerCase());
    assert.equal(person.role, null);
    assert.ok(found.length <= 8);
    assert.deepEqual(Object.keys(person).sort(), ["avatarUrl", "color", "handle", "id", "inherited", "name", "role"]);
    // Wildcards are literal and the query is bounded.
    if (!admitted.name.includes("%"))
      assert.equal(((await search(owner, "%")).people as any[]).some((item) => item.id === memberId), false);
    await search(owner, "x".repeat(101), 400);

    // Direct share: access at once, no invitation to accept.
    const granted = await owner.call(`${base}/share`, { userId: memberId, role: "commenter" }, 201);
    assert.equal(granted.granted, true);
    assert.equal(granted.changed, true);
    assert.equal("token" in granted, false);
    assert.equal(granted.collaborator.id, memberId);
    assert.equal(granted.collaborator.role, "commenter");
    // Sharing again with less access changes nothing.
    const repeated = await owner.call(`${base}/share`, { userId: memberId, role: "viewer" }, 200);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.collaborator.role, "commenter");
    assert.equal((await search(owner, admitted.name)).people.find((item: any) => item.id === memberId)?.role, "commenter");

    const state = await member.call(`${base}/share`);
    assert.equal(state.capabilities.role, "commenter");
    assert.equal(state.capabilities.share, false);
    const notifications = (await member.call("/api/v1/notifications")).notifications as any[];
    assert.ok(
      notifications.some((item) => item.kind === "share" && item.href === `/boards/${encodeURIComponent(board.id)}`),
      "the member is told about the share",
    );
    // Access to the board does not grant the directory.
    await search(member, admitted.name, 403);
    await member.call(`${base}/share`, { userId: memberId, role: "editor" }, 403);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS n FROM security_audit WHERE action = 'board.shared' AND target_id = ? AND created_at >= ?").get(board.id, startedAt) as { n: number }).n,
      1,
    );
  } finally {
    await owner.call(`${base}/collaborators/${encodeURIComponent(memberId)}`, undefined, [200, 404], "DELETE");
    database
      .prepare("DELETE FROM notifications WHERE user_id = ? AND kind = 'share' AND board_id = ? AND created_at >= ?")
      .run(memberId, board.id, startedAt);
    if (previous)
      database
        .prepare(
          "INSERT INTO resource_grants (resource_type, resource_id, user_id, role, source, expires_at, created_at, updated_at) VALUES ('board', ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(board.id, memberId, previous.role, previous.source, previous.expiresAt, previous.createdAt, previous.updatedAt);
  }
  console.log("Native sharing: owner people search, direct share, no-downgrade, member notification and member search denial passed.");
}
