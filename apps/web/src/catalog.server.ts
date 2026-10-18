import { requireWorkbookRole } from './collaboration.server';
import { roleAtLeast, type Principal, type Role } from './collaboration-types';
import { HttpError } from './security/errors';
import { boundedBody, text } from './security/primitives';

export type CatalogFolder = {
  id: string;
  parentId: string | null;
  title: string;
};

export type CatalogWorkbook = {
  id: string;
  folderId: string | null;
  title: string;
};

export type CatalogBoard = {
  id: string;
  workbookId: string;
  title: string;
  favorite: boolean;
  updatedAt: string;
  lastOpenedAt: string | null;
  private: boolean;
};

export type CatalogResponse = {
  folders: CatalogFolder[];
  workbooks: CatalogWorkbook[];
  boards: CatalogBoard[];
};

// DDL and migration run during deployment, never in authenticated requests.
export async function ensureCatalog(_database: D1Database) {}

export async function readCatalog(database: D1Database): Promise<CatalogResponse> {
  await ensureCatalog(database);
  const [folders, workbooks, boards] = await database.batch([
    database.prepare(
      'SELECT id, parent_id AS parentId, title FROM folders WHERE deleted_at IS NULL ORDER BY sort_order, title'
    ),
    database.prepare(
      'SELECT id, folder_id AS folderId, title FROM workbooks WHERE deleted_at IS NULL ORDER BY sort_order, title'
    ),
    database.prepare(
      'SELECT id, workbook_id AS workbookId, title, favorite, inheritance_disabled AS private, updated_at AS updatedAt, last_opened_at AS lastOpenedAt FROM boards WHERE deleted_at IS NULL ORDER BY favorite DESC, updated_at DESC'
    ),
  ]);
  return {
    folders: folders.results as CatalogFolder[],
    workbooks: workbooks.results as CatalogWorkbook[],
    boards: (boards.results as (Omit<CatalogBoard, 'favorite' | 'private'> & {
      favorite: number;
      private: number;
    })[]).map(board => ({ ...board, favorite: Boolean(board.favorite), private: Boolean(board.private) })),
  };
}

function readTitle(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('JSON body required');
  const title = (value as { title?: unknown }).title;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) {
    throw new Error('Title must be between 1 and 120 characters');
  }
  return title.trim();
}

function requireObject(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('JSON body required');
  }
  return value as Record<string, unknown>;
}

async function requireActiveBoard(database: D1Database, boardId: string) {
  const board = await database
    .prepare(
      'SELECT id, workbook_id AS workbookId, title, favorite, inheritance_disabled AS private, updated_at AS updatedAt, last_opened_at AS lastOpenedAt FROM boards WHERE id = ? AND deleted_at IS NULL'
    )
    .bind(boardId)
    .first<Omit<CatalogBoard, 'favorite' | 'private'> & { favorite: number; private: number }>();
  if (!board) throw new Error('Board not found');
  return { ...board, favorite: Boolean(board.favorite), private: Boolean(board.private) } satisfies CatalogBoard;
}

export async function createFolder(database: D1Database, body: unknown, principal?: Principal) {
  await ensureCatalog(database);
  const title = readTitle(body);
  const parentId = (body as { parentId?: unknown }).parentId;
  const id = `folder:${crypto.randomUUID()}`;
  if (typeof parentId === 'string' && principal) await requireFolderOwner(database, parentId, principal.id);
  await database
    .prepare(
      'INSERT INTO folders (id, parent_id, title, created_at, owner_id) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(id, typeof parentId === 'string' ? parentId : null, title, new Date().toISOString(), principal?.id ?? null)
    .run();
  return { id, title, parentId: typeof parentId === 'string' ? parentId : null };
}

export async function createWorkbook(database: D1Database, body: unknown, principal?: Principal) {
  await ensureCatalog(database);
  const title = readTitle(body);
  const folderId = (body as { folderId?: unknown }).folderId;
  const id = `workbook:${crypto.randomUUID()}`;
  if (typeof folderId === 'string' && principal) await requireFolderOwner(database, folderId, principal.id);
  await database
    .prepare(
      'INSERT INTO workbooks (id, folder_id, title, created_at) VALUES (?, ?, ?, ?)'
    )
    .bind(id, typeof folderId === 'string' ? folderId : null, title, new Date().toISOString())
    .run();
  return { id, title, folderId: typeof folderId === 'string' ? folderId : null };
}

/**
 * Renaming or filing a workbook does not change its grants or board access.
 *
 * `folderId` is optional: omitted means "leave the filing alone". A workbook has
 * one folder column, but each person only sees folders they own (see
 * authorizedCatalog), so a co-owner who renames a workbook filed in someone
 * else's folder must not send `folderId: null` and silently unfile it.
 */
export async function updateWorkbook(database: D1Database, id: string, body: unknown, principal: Principal) {
  await requireWorkbookRole(database, id, principal, 'owner');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Provide a workbook name or folder.', 'INVALID_INPUT');
  const { title, folderId } = body as Record<string, unknown>;
  if ((title !== undefined && (typeof title !== 'string' || !title.trim() || title.trim().length > 120)) ||
      (folderId !== undefined && folderId !== null && (typeof folderId !== 'string' || !folderId.trim())) ||
      (title === undefined && folderId === undefined)) {
    throw new HttpError(400, 'Enter a name of up to 120 characters and choose a folder.', 'INVALID_INPUT');
  }
  if (typeof folderId === 'string') await requireFolderOwner(database, folderId, principal.id);
  const name = typeof title === 'string' ? title.trim() : undefined;
  if (name !== undefined && folderId !== undefined) {
    await database.prepare('UPDATE workbooks SET title = ?, folder_id = ? WHERE id = ? AND deleted_at IS NULL').bind(name, folderId, id).run();
  } else if (name !== undefined) {
    await database.prepare('UPDATE workbooks SET title = ? WHERE id = ? AND deleted_at IS NULL').bind(name, id).run();
  } else {
    await database.prepare('UPDATE workbooks SET folder_id = ? WHERE id = ? AND deleted_at IS NULL').bind(folderId, id).run();
  }
  const row = await database
    .prepare('SELECT w.title AS title, w.folder_id AS folderId, f.owner_id AS folderOwner FROM workbooks w LEFT JOIN folders f ON f.id = w.folder_id AND f.deleted_at IS NULL WHERE w.id = ? AND w.deleted_at IS NULL')
    .bind(id)
    .first<{ title: string; folderId: string | null; folderOwner: string | null }>();
  if (!row) throw new HttpError(404, 'Workbook not found.', 'NOT_FOUND');
  // Report the filing as this person sees it: another owner's folder stays private.
  return { id, title: row.title, folderId: row.folderId && row.folderOwner === principal.id ? row.folderId : null };
}

/**
 * Folders are private, but a workbook has one folder column shared by all of
 * its owners. Flag workbooks another person has filed in a folder this viewer
 * cannot see, so the Studio can explain that filing it here moves it for them.
 */
export function markFiledElsewhere<C extends { workbooks: Array<{ id: string; folderId: string | null }> }>(raw: CatalogResponse, visible: C) {
  const filed = new Map(raw.workbooks.map(workbook => [workbook.id, workbook.folderId]));
  return {
    ...visible,
    workbooks: visible.workbooks.map(workbook => ({ ...workbook, filedElsewhere: !workbook.folderId && Boolean(filed.get(workbook.id)) })),
  };
}

/** Accept an empty request body as `{}` for actions whose options are all optional. */
export async function optionalJsonObject(request: Pick<Request, 'headers' | 'body'>, max = 100_000): Promise<Record<string, unknown>> {
  const text = new TextDecoder().decode(await boundedBody(request, max)).trim();
  if (!text) return {};
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new HttpError(400, 'A JSON object is required.', 'INVALID_INPUT'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'A JSON object is required.', 'INVALID_INPUT');
  return value as Record<string, unknown>;
}

export async function createBoard(database: D1Database, body: unknown, principal?: Principal) {
  await ensureCatalog(database);
  const title = readTitle(body);
  const workbookId = (body as { workbookId?: unknown }).workbookId;
  if (typeof workbookId !== 'string') throw new Error('workbookId is required');
  const id = `board:${crypto.randomUUID()}`;
  const privateBoard = (body as { private?: unknown }).private === true;
  const now = new Date().toISOString();
  await database
    .prepare(
      'INSERT INTO boards (id, workbook_id, title, inheritance_disabled, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(id, workbookId, title, Number(privateBoard), now, now, principal?.id ?? null)
    .run();
  return { id, title, workbookId, favorite: false, private: privateBoard, updatedAt: now };
}

export async function readBoard(database: D1Database, boardId: string) {
  await ensureCatalog(database);
  return requireActiveBoard(database, boardId);
}

export async function updateBoard(
  database: D1Database,
  boardId: string,
  body: unknown
) {
  await ensureCatalog(database);
  const input = requireObject(body);
  await requireActiveBoard(database, boardId);

  const title = input.title === undefined ? undefined : readTitle(input);
  const workbookId = input.workbookId;
  const privateBoard = input.private;
  if (workbookId !== undefined && typeof workbookId !== 'string') {
    throw new Error('workbookId must be a string');
  }
  if (input.favorite !== undefined && typeof input.favorite !== 'boolean') {
    throw new Error('favorite must be a boolean');
  }
  if (privateBoard !== undefined && typeof privateBoard !== 'boolean') {
    throw new Error('private must be a boolean');
  }
  if (title === undefined && workbookId === undefined && input.favorite === undefined && privateBoard === undefined) {
    throw new Error('Provide title, workbookId, favorite, or private');
  }

  // Renaming, filing or privacy are not content edits: "Edited" and recency
  // order only change when the board itself changes (markBoardUpdated).
  await database
    .prepare(
      'UPDATE boards SET title = COALESCE(?, title), workbook_id = COALESCE(?, workbook_id), favorite = COALESCE(?, favorite), inheritance_disabled = COALESCE(?, inheritance_disabled) WHERE id = ? AND deleted_at IS NULL'
    )
    .bind(
      title ?? null,
      workbookId ?? null,
      typeof input.favorite === 'boolean' ? Number(input.favorite) : null,
      typeof privateBoard === 'boolean' ? Number(privateBoard) : null,
      boardId
    )
    .run();
  return requireActiveBoard(database, boardId);
}

export async function trashBoard(database: D1Database, boardId: string) {
  await ensureCatalog(database);
  await requireActiveBoard(database, boardId);
  const now = new Date().toISOString();
  // Keep updated_at so a restored board returns to its place in recency order.
  await database
    .prepare('UPDATE boards SET deleted_at = ? WHERE id = ?')
    .bind(now, boardId)
    .run();
  return { id: boardId, trashedAt: now };
}

export async function trashWorkbook(database: D1Database, workbookId: string) {
  await ensureCatalog(database);
  const active = await database
    .prepare(
      'SELECT COUNT(*) AS count FROM boards WHERE workbook_id = ? AND deleted_at IS NULL'
    )
    .bind(workbookId)
    .first<{ count: number }>();
  if (Number(active?.count ?? 0) > 0) {
    throw new Error('Move or trash the workbook boards first');
  }
  const result = await database
    .prepare('UPDATE workbooks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(new Date().toISOString(), workbookId)
    .run();
  if (!result.meta.changes) throw new Error('Workbook not found');
  return { id: workbookId };
}

export async function markBoardOpened(database: D1Database, boardId: string) {
  await ensureCatalog(database);
  await database
    .prepare('UPDATE boards SET last_opened_at = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(new Date().toISOString(), boardId)
    .run();
}

export async function markBoardUpdated(database: D1Database, boardId: string) {
  await ensureCatalog(database);
  await database
    .prepare(
      'UPDATE boards SET updated_at = ? WHERE id = ? AND deleted_at IS NULL'
    )
    .bind(new Date().toISOString(), boardId)
    .run();
}

export async function requireFolderOwner(database: D1Database, id: string, userId: string) {
  if (!await database.prepare('SELECT id FROM folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL').bind(id, userId).first()) throw new HttpError(404, 'Folder not found.', 'NOT_FOUND');
}

// ---------------------------------------------------------------------------
// Trash, restore and folder management.
//
// Trashed boards and workbooks keep their rows (deleted_at is set) and are kept
// until restored; nothing purges them automatically. A board's owner can trash
// and restore it. Deleting a workbook trashes its boards with the same
// timestamp, so restoring the workbook brings back exactly those boards.
//
// These functions are the single implementation for every auth mode: the
// native routes (auth/content.ts) and the Worker routes both call them.

type GrantedRow = { directRole: Role | null; workbookRole: Role | null; private: number };

function effectiveRole(row: GrantedRow): Role | null {
  const inherited = row.private ? null : row.workbookRole;
  if (!row.directRole) return inherited;
  if (!inherited) return row.directRole;
  return roleAtLeast(row.directRole, inherited) ? row.directRole : inherited;
}

function permittedResource(principal: Principal, boardId: string, workbookId: string) {
  return principal.resourceMode !== 'selected' || Boolean(principal.resources?.some(resource =>
    (resource.type === 'board' && resource.id === boardId) || (resource.type === 'workbook' && resource.id === workbookId)));
}

const timestamp = () => new Date().toISOString();

type TrashedBoardRow = GrantedRow & {
  id: string;
  title: string;
  workbookId: string;
  workbookTitle: string | null;
  workbookDeletedAt: string | null;
  deletedAt: string;
  updatedAt: string;
};

export type TrashedBoard = Omit<TrashedBoardRow, 'directRole' | 'workbookRole' | 'private'> & { private: boolean };
export type TrashedWorkbook = { id: string; title: string; deletedAt: string; boardCount: number };

// The workbook's name and state are only shown to people with a grant on it.
const TRASHED_BOARD_COLUMNS = `b.id, b.title, b.workbook_id AS workbookId, b.deleted_at AS deletedAt, b.updated_at AS updatedAt,
           b.inheritance_disabled AS private,
           CASE WHEN wg.role IS NOT NULL THEN w.title END AS workbookTitle,
           CASE WHEN wg.role IS NOT NULL THEN w.deleted_at END AS workbookDeletedAt,
           bg.role AS directRole, wg.role AS workbookRole`;

async function requireTrashedBoardOwner(database: D1Database, boardId: string, principal: Principal) {
  const at = timestamp();
  const row = await database.prepare(`
    SELECT ${TRASHED_BOARD_COLUMNS}, w.deleted_at AS workbookTrashed
    FROM boards b
    LEFT JOIN workbooks w ON w.id = b.workbook_id
    LEFT JOIN resource_grants bg ON bg.resource_type = 'board' AND bg.resource_id = b.id AND bg.user_id = ? AND (bg.expires_at IS NULL OR bg.expires_at > ?)
    LEFT JOIN resource_grants wg ON wg.resource_type = 'workbook' AND wg.resource_id = b.workbook_id AND wg.user_id = ? AND (wg.expires_at IS NULL OR wg.expires_at > ?)
    WHERE b.id = ? AND b.deleted_at IS NOT NULL
  `).bind(principal.id, at, principal.id, at, boardId).first<TrashedBoardRow & { workbookTrashed: string | null }>();
  const role = row ? effectiveRole(row) : null;
  if (!row || !role || !permittedResource(principal, row.id, row.workbookId)) throw new HttpError(404, 'Board not found in trash.', 'BOARD_NOT_FOUND');
  if (role !== 'owner') throw new HttpError(403, 'Only the board owner can restore it.', 'PERMISSION_DENIED');
  return row;
}

/** Boards and workbooks this person owns that are in the trash, newest first. */
export async function listTrash(database: D1Database, principal: Principal) {
  const at = timestamp();
  const [boardRows, workbookRows] = await database.batch([
    // Ownership is decided in SQL so the limit only counts boards this person owns,
    // and boards trashed together with a workbook they own are listed under it.
    database.prepare(`
      SELECT ${TRASHED_BOARD_COLUMNS}
      FROM boards b
      LEFT JOIN workbooks w ON w.id = b.workbook_id
      LEFT JOIN resource_grants bg ON bg.resource_type = 'board' AND bg.resource_id = b.id AND bg.user_id = ? AND (bg.expires_at IS NULL OR bg.expires_at > ?)
      LEFT JOIN resource_grants wg ON wg.resource_type = 'workbook' AND wg.resource_id = b.workbook_id AND wg.user_id = ? AND (wg.expires_at IS NULL OR wg.expires_at > ?)
      WHERE b.deleted_at IS NOT NULL
        AND (bg.role = 'owner' OR (b.inheritance_disabled = 0 AND wg.role = 'owner'))
        AND NOT (wg.role = 'owner' AND w.deleted_at IS NOT NULL AND w.deleted_at = b.deleted_at)
      ORDER BY b.deleted_at DESC
      LIMIT 500
    `).bind(principal.id, at, principal.id, at),
    database.prepare(`
      SELECT w.id, w.title, w.deleted_at AS deletedAt,
             (SELECT COUNT(*) FROM boards b WHERE b.workbook_id = w.id AND b.deleted_at = w.deleted_at) AS boardCount
      FROM workbooks w
      JOIN resource_grants g ON g.resource_type = 'workbook' AND g.resource_id = w.id AND g.user_id = ? AND g.role = 'owner' AND (g.expires_at IS NULL OR g.expires_at > ?)
      WHERE w.deleted_at IS NOT NULL
      ORDER BY w.deleted_at DESC
      LIMIT 200
    `).bind(principal.id, at),
  ]);
  const workbooks = (workbookRows.results as Array<TrashedWorkbook & { boardCount: number | string }>)
    .filter(workbook => permittedResource(principal, '', workbook.id))
    .map(workbook => ({ ...workbook, boardCount: Number(workbook.boardCount) }));
  const boards = (boardRows.results as TrashedBoardRow[])
    .filter(row => effectiveRole(row) === 'owner' && permittedResource(principal, row.id, row.workbookId))
    .map(({ directRole: _direct, workbookRole: _workbook, ...row }) => ({ ...row, private: Boolean(row.private) }) satisfies TrashedBoard);
  return { boards, workbooks };
}

/**
 * Restore a trashed board into its workbook. If that workbook is itself in the
 * trash, the caller must choose another workbook (`workbookId`). Any chosen
 * workbook must be active and editable by the caller, including the board's
 * own workbook. `beforeMove` runs after every check and before the board moves,
 * so a move can grant ownership first, as a normal move does.
 */
export async function restoreBoard(database: D1Database, boardId: string, body: unknown, principal: Principal, beforeMove?: () => Promise<void>) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (input.workbookId !== undefined && (typeof input.workbookId !== 'string' || !input.workbookId)) throw new HttpError(400, 'Choose a workbook.', 'INVALID_INPUT');
  const board = await requireTrashedBoardOwner(database, boardId, principal);
  const target = typeof input.workbookId === 'string' ? input.workbookId : null;
  if (!target && board.workbookTrashed) throw new HttpError(409, 'Its workbook is in the trash. Choose where to restore it.', 'WORKBOOK_TRASHED');
  // requireWorkbookRole only accepts active workbooks, so a trashed one is never a destination.
  if (target) await requireWorkbookRole(database, target, principal, 'editor');
  const workbookId = target ?? board.workbookId;
  const moved = workbookId !== board.workbookId;
  if (moved) await beforeMove?.();
  const result = await database.prepare('UPDATE boards SET deleted_at = NULL, workbook_id = ? WHERE id = ? AND deleted_at IS NOT NULL AND EXISTS(SELECT 1 FROM workbooks w WHERE w.id = ? AND w.deleted_at IS NULL)')
    .bind(workbookId, boardId, workbookId).run();
  if (!result.meta.changes) throw new HttpError(409, 'Its workbook is in the trash. Choose where to restore it.', 'WORKBOOK_TRASHED');
  return { id: boardId, workbookId, moved };
}

// Private boards in this workbook that the caller does not own (respecting grant expiry).
const OTHERS_PRIVATE_BOARDS = `SELECT 1 FROM boards p
      WHERE p.workbook_id = ? AND p.deleted_at IS NULL AND p.inheritance_disabled = 1
        AND NOT EXISTS (SELECT 1 FROM resource_grants g WHERE g.resource_type = 'board' AND g.resource_id = p.id AND g.user_id = ? AND g.role = 'owner' AND (g.expires_at IS NULL OR g.expires_at > ?))`;

/**
 * Delete a workbook: it and its boards go to the trash together. Private
 * boards someone else owns are never trashed on their behalf; the check is
 * part of each update, so a board made private concurrently cannot slip through.
 */
export async function deleteWorkbook(database: D1Database, workbookId: string, principal: Principal) {
  await requireWorkbookRole(database, workbookId, principal, 'owner');
  const at = timestamp();
  const [boards, workbook] = await database.batch([
    database.prepare(`UPDATE boards SET deleted_at = ? WHERE workbook_id = ? AND deleted_at IS NULL AND NOT EXISTS (${OTHERS_PRIVATE_BOARDS})`)
      .bind(at, workbookId, workbookId, principal.id, at),
    database.prepare(`UPDATE workbooks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL AND NOT EXISTS (${OTHERS_PRIVATE_BOARDS})`)
      .bind(at, workbookId, workbookId, principal.id, at),
  ]);
  if (!workbook.meta.changes) {
    const blocked = await database.prepare(OTHERS_PRIVATE_BOARDS).bind(workbookId, principal.id, timestamp()).first();
    if (blocked) throw new HttpError(409, 'This workbook has private boards that belong to other people. Ask them to move those boards first.', 'WORKBOOK_HAS_PRIVATE_BOARDS');
    throw new HttpError(404, 'Workbook not found', 'WORKBOOK_NOT_FOUND');
  }
  return { id: workbookId, trashedAt: at, boards: Number(boards.meta.changes ?? 0) };
}

/** Bring back a workbook and the boards that were trashed with it. */
export async function restoreWorkbook(database: D1Database, workbookId: string, principal: Principal) {
  if (principal.resourceMode === 'selected' && !permittedResource(principal, '', workbookId)) throw new HttpError(404, 'Workbook not found in trash.', 'WORKBOOK_NOT_FOUND');
  const at = timestamp();
  const row = await database.prepare(`
    SELECT w.deleted_at AS deletedAt, g.role FROM workbooks w
    LEFT JOIN resource_grants g ON g.resource_type = 'workbook' AND g.resource_id = w.id AND g.user_id = ? AND (g.expires_at IS NULL OR g.expires_at > ?)
    WHERE w.id = ? AND w.deleted_at IS NOT NULL
  `).bind(principal.id, at, workbookId).first<{ deletedAt: string; role: Role | null }>();
  if (!row?.role) throw new HttpError(404, 'Workbook not found in trash.', 'WORKBOOK_NOT_FOUND');
  if (row.role !== 'owner') throw new HttpError(403, 'Only the workbook owner can restore it.', 'PERMISSION_DENIED');
  const [, boards] = await database.batch([
    database.prepare('UPDATE workbooks SET deleted_at = NULL WHERE id = ? AND deleted_at = ?').bind(workbookId, row.deletedAt),
    database.prepare('UPDATE boards SET deleted_at = NULL WHERE workbook_id = ? AND deleted_at = ?').bind(workbookId, row.deletedAt),
  ]);
  return { id: workbookId, boards: Number(boards.meta.changes ?? 0) };
}

function folderOwnerOnly(principal: Principal) {
  // Folders belong to a person, not to a resource an app was granted.
  if (principal.resourceMode === 'selected') throw new HttpError(404, 'Folder not found.', 'NOT_FOUND');
}

/**
 * Rename a folder and/or move it under another folder you own. Moves are
 * checked for cycles, both up front and inside the update itself.
 */
export async function updateFolder(database: D1Database, id: string, body: unknown, principal: Principal) {
  folderOwnerOnly(principal);
  const input = requireBody(body, 'Choose a name or destination.');
  await requireFolderOwner(database, id, principal.id);
  const title = input.title === undefined ? null : text(input.title, 'Folder name');
  const parentId = input.parentId === undefined ? undefined : input.parentId === null ? null : text(input.parentId, 'Parent folder', 200);
  if (parentId) {
    await requireFolderOwner(database, parentId, principal.id);
    const cycle = await database.prepare(
      'WITH RECURSIVE ancestors(id, parent_id) AS (SELECT id, parent_id FROM folders WHERE id = ? UNION SELECT f.id, f.parent_id FROM folders f JOIN ancestors a ON f.id = a.parent_id) SELECT id FROM ancestors WHERE id = ?',
    ).bind(parentId, id).first();
    if (cycle) throw new HttpError(400, 'A folder cannot contain itself.', 'FOLDER_CYCLE');
  }
  if (title === null && parentId === undefined) throw new HttpError(400, 'Choose a name or destination.', 'INVALID_INPUT');
  const changed = await database.prepare(
    `UPDATE folders SET title = COALESCE(?, title)${parentId === undefined ? "" : ", parent_id = ?"} WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
    ${
      parentId
        ? `AND EXISTS(SELECT 1 FROM folders p WHERE p.id = ? AND p.owner_id = ? AND p.deleted_at IS NULL)
      AND NOT EXISTS(WITH RECURSIVE ancestors(id, parent_id) AS (SELECT id, parent_id FROM folders WHERE id = ? UNION SELECT f.id, f.parent_id FROM folders f JOIN ancestors a ON f.id = a.parent_id) SELECT id FROM ancestors WHERE id = folders.id)`
        : ""
    }
    RETURNING id, title`,
  ).bind(
    title,
    ...(parentId === undefined ? [] : [parentId]),
    id,
    principal.id,
    ...(parentId ? [parentId, principal.id, parentId] : []),
  ).first<{ id: string; title: string }>();
  if (!changed) throw new HttpError(409, 'The folder or destination changed. Refresh and choose its destination again.', 'FOLDER_CONFLICT');
  return { updated: true, id, title: changed.title };
}

function requireBody(body: unknown, message: string) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, message, 'INVALID_INPUT');
  return body as Record<string, unknown>;
}

/**
 * Delete a folder. Its workbooks become unfiled and its subfolders move to the
 * top level; nothing else is deleted. The ids it moved are returned so the
 * Studio can offer Undo (restoreFolder).
 */
export async function deleteFolder(database: D1Database, folderId: string, principal: Principal) {
  folderOwnerOnly(principal);
  await requireFolderOwner(database, folderId, principal.id);
  // Capture exactly the contents moved by this deletion in the same transaction.
  const owned = 'EXISTS(SELECT 1 FROM folders o WHERE o.id = ? AND o.owner_id = ? AND o.deleted_at IS NULL)';
  const [filed, nested, workbooks, , folder] = await database.batch([
    database.prepare(`SELECT id FROM workbooks WHERE folder_id = ? AND deleted_at IS NULL AND ${owned}`).bind(folderId, folderId, principal.id),
    database.prepare(`SELECT id FROM folders WHERE parent_id = ? AND owner_id = ? AND deleted_at IS NULL AND ${owned}`).bind(folderId, principal.id, folderId, principal.id),
    database.prepare(`UPDATE workbooks SET folder_id = NULL WHERE folder_id = ? AND deleted_at IS NULL AND ${owned}`).bind(folderId, folderId, principal.id),
    database.prepare(`UPDATE folders SET parent_id = NULL WHERE parent_id = ? AND owner_id = ? AND deleted_at IS NULL AND ${owned}`).bind(folderId, principal.id, folderId, principal.id),
    database.prepare('UPDATE folders SET deleted_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL').bind(timestamp(), folderId, principal.id),
  ]);
  if (!folder.meta.changes) throw new HttpError(404, 'Folder not found.', 'NOT_FOUND');
  return {
    deleted: true,
    id: folderId,
    unfiled: Number(workbooks.meta.changes ?? 0),
    workbookIds: (filed.results as { id: string }[]).map(row => row.id),
    folderIds: (nested.results as { id: string }[]).map(row => row.id),
  };
}

function idList(value: unknown, label: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500 || !value.every(item => typeof item === 'string' && item.length <= 200)) {
    throw new HttpError(400, `${label} must be a list of ids.`, 'INVALID_INPUT');
  }
  return value as string[];
}

/**
 * Undo a folder delete: bring the folder back and re-file the workbooks and
 * subfolders it held, if they are still unfiled. Only workbooks the caller
 * owns are re-filed, so the list cannot be used to file anything else.
 */
export async function restoreFolder(database: D1Database, folderId: string, body: unknown, principal: Principal) {
  folderOwnerOnly(principal);
  const input = requireBody(body ?? {}, 'Provide the workbooks to re-file.');
  const workbookIds = idList(input.workbookIds, 'workbookIds');
  const folderIds = idList(input.folderIds, 'folderIds');
  const at = timestamp();
  // Keep the folder in trash until its contents are restored. Every statement
  // checks that same condition; the whole batch either commits or rolls back.
  const restorable = 'EXISTS(SELECT 1 FROM folders o WHERE o.id = ? AND o.owner_id = ? AND o.deleted_at IS NOT NULL)';
  const refile = database.prepare(`UPDATE workbooks SET folder_id = ? WHERE id = ? AND folder_id IS NULL AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM resource_grants g WHERE g.resource_type = 'workbook' AND g.resource_id = workbooks.id AND g.user_id = ? AND g.role = 'owner' AND (g.expires_at IS NULL OR g.expires_at > ?)) AND ${restorable}`);
  const nest = database.prepare(`UPDATE folders SET parent_id = ? WHERE id = ? AND parent_id IS NULL AND owner_id = ? AND deleted_at IS NULL
      AND ${restorable}
      AND NOT EXISTS(WITH RECURSIVE ancestors(id, parent_id) AS (SELECT id, parent_id FROM folders WHERE id = ? UNION SELECT f.id, f.parent_id FROM folders f JOIN ancestors a ON f.id = a.parent_id) SELECT id FROM ancestors WHERE id = folders.id)`);
  const results = await database.batch([
    ...workbookIds.map(id => refile.bind(folderId, id, principal.id, at, folderId, principal.id)),
    ...folderIds.map(id => nest.bind(folderId, id, principal.id, folderId, principal.id, folderId)),
    database.prepare(`UPDATE folders SET deleted_at = NULL, parent_id = CASE
      WHEN EXISTS(SELECT 1 FROM folders p WHERE p.id = folders.parent_id AND p.owner_id = ? AND p.deleted_at IS NULL) THEN parent_id ELSE NULL END
      WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL`).bind(principal.id, folderId, principal.id),
  ]);
  if (!results.at(-1)?.meta.changes) throw new HttpError(404, 'Folder not found in the trash.', 'NOT_FOUND');
  const refiled = results.slice(0, workbookIds.length).reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);
  return { restored: true, id: folderId, refiled };
}

/** Accepting an invitation answers its notification, however it was accepted. One statement. */
export async function readAcceptedInvitationNotifications(database: D1Database, principal: Principal, resourceType: string, resourceId: string) {
  await database.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND event_key IN (
      SELECT 'invitation:' || i.id || ':' || ? FROM invitations i WHERE i.accepted_by = ? AND i.resource_type = ? AND i.resource_id = ?)`)
    .bind(timestamp(), principal.id, principal.id, principal.id, resourceType, resourceId).run();
}
