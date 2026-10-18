import type { NativeEnv } from "./types";
import { deleteFolder, updateFolder } from "../catalog.server";
import { nativePrincipal } from "./session";
import { json } from "../security/primitives";

/** Stable private starter resources; safe to retry after interrupted admission. */
export function starterStatements(database: D1Database, userId: string) {
  const at = new Date().toISOString();
  const folder = `folder:${userId}:personal`;
  const workbook = `workbook:${userId}:ideas`;
  const eligible =
    "EXISTS(SELECT 1 FROM instance_memberships m JOIN account_security s ON s.user_id = m.user_id WHERE m.user_id = ? AND m.role <> 'guest' AND s.status = 'active')";
  return [
    database
      .prepare(
        `INSERT OR IGNORE INTO folders (id, title, owner_id, created_at) SELECT ?, 'Personal', ?, ? WHERE ${eligible}`,
      )
      .bind(folder, userId, at, userId),
    database
      .prepare(
        `INSERT OR IGNORE INTO workbooks (id, folder_id, title, created_at) SELECT ?, ?, 'Ideas', ? WHERE ${eligible}`,
      )
      .bind(workbook, folder, at, userId),
    database
      .prepare(
        `INSERT OR IGNORE INTO resource_grants (resource_type, resource_id, user_id, role, source, created_at, updated_at) SELECT 'workbook', ?, ?, 'owner', 'direct', ?, ? WHERE ${eligible}`,
      )
      .bind(workbook, userId, at, at, userId),
  ];
}
/**
 * Native folder routes. They resolve the native session, then use the same
 * catalog functions as every other auth mode: rename and move with cycle
 * checks, and delete, which unfiles workbooks and never deletes them.
 */
export async function folderRoutes(request: Request, env: NativeEnv) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/v1\/folders\/([^/]+)$/u);
  if (!match || !["PATCH", "DELETE"].includes(request.method)) return null;
  const { principal } = await nativePrincipal(request, env);
  const id = decodeURIComponent(match[1]);
  if (request.method === "DELETE")
    return Response.json(await deleteFolder(env.CATALOG, id, principal));
  return Response.json(await updateFolder(env.CATALOG, id, await json(request), principal));
}
