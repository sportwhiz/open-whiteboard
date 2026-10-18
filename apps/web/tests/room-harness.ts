// Shared harness: drive BoardRoom as both the Cloudflare Durable Object and
// the Node.js room runtime (MySQL-backed room storage) do.
import type { PoolConnection } from 'mysql2/promise';
import { BoardRoom } from '../src/board-room';
import { createHeadlessBoard } from '../src/blocksuite/headless-board';
import { captureNativeSnapshot } from '../src/blocksuite/runtime/snapshot';
import { capabilitiesForRole, type Principal, type Role } from '../src/collaboration-types';
import { createRoomStorage } from '../src/node/rooms';

export type Storage = Record<string, unknown> & {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
};

export function durableObjectStorage() {
  const values = new Map<string, unknown>();
  const clone = <T>(value: T): T => structuredClone(value);
  const raw = {
    async get<T>(key: string) { return values.has(key) ? clone(values.get(key)) as T : undefined; },
    async put(key: string, value: unknown) { values.set(key, clone(value)); },
    async delete(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) values.delete(key); return true; },
    async list<T>(options: { prefix?: string; reverse?: boolean; limit?: number } = {}) {
      const keys = [...values.keys()].filter(key => key.startsWith(options.prefix ?? '')).sort();
      if (options.reverse) keys.reverse();
      return new Map(keys.slice(0, options.limit ?? keys.length).map(key => [key, clone(values.get(key)) as T]));
    },
  };
  return { ...raw, async transaction<T>(callback: (tx: typeof raw) => Promise<T>) { return callback(raw); }, async setAlarm() {}, async deleteAlarm() {} } as unknown as Storage;
}

export function mysqlConnection() {
  const values = new Map<string, { key: string; part: number; value: Buffer }>();
  return {
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    execute: async (sql: string, args: unknown[]) => {
      if (sql.includes('node_room_alarms')) return [{}];
      const item = (args[1] as Buffer)?.toString();
      if (sql.startsWith('DELETE FROM node_room_values')) {
        let affectedRows = 0;
        for (const [id, row] of values) if (row.key === item) { values.delete(id); affectedRows += 1; }
        return [{ affectedRows }];
      }
      if (sql.startsWith('INSERT INTO node_room_values')) {
        values.set(`${item}:${args[2]}`, { key: item, part: args[2] as number, value: args[3] as Buffer });
        return [{}];
      }
      if (sql.startsWith('SELECT value')) return [[...values.values()].filter(row => row.key === item).sort((a, b) => a.part - b.part)];
      if (sql.startsWith('SELECT DISTINCT')) {
        const prefix = (args[2] as Buffer).toString();
        const keys = [...new Set([...values.values()].map(row => row.key))].filter(key => key.startsWith(prefix)).sort();
        if (sql.includes('DESC')) keys.reverse();
        return [keys.slice(0, Number(sql.split('LIMIT ')[1])).map(key => ({ item_key: Buffer.from(key) }))];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

export const catalog = { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }), batch: async () => [] } as unknown as D1Database;
export const owner: Principal = {
  id: 'owner', email: 'owner@example.test', name: 'Facilitator', avatarUrl: null, color: '#3D4A73',
  issuer: 'test', subject: 'owner', sessionId: 'session', expiresAt: null, authentication: 'local-development',
};
export const header = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));


export const storages = [
  ['Cloudflare Durable Object', () => durableObjectStorage()],
  ['Node.js room storage', () => createRoomStorage(mysqlConnection() as unknown as PoolConnection, 'board:board-1') as unknown as Storage],
] as const;

export function person(id: string, name = id): Principal {
  return { ...owner, id, name, subject: id, email: `${id}@example.test` };
}

/** A room with an empty board, and a helper to send commands as anyone. */
export async function roomWith(storage: Storage, sockets: unknown[] = [], database: D1Database = catalog) {
  const fixture = createHeadlessBoard([], 'room-harness', { includeFrames: false });
  await storage.put('board', { revision: 1, updatedAt: new Date().toISOString(), documentEpoch: 'epoch', snapshot: captureNativeSnapshot(fixture.workspace) });
  fixture.workspace.dispose();
  const room = new BoardRoom({ storage, getWebSockets: () => sockets } as unknown as DurableObjectState, { CATALOG: database });
  let operation = 0;
  const as = (principal: Principal, role: Role = 'editor') => ({
    'X-Whiteboard-Principal': header(principal),
    'X-Whiteboard-Capabilities': header(capabilitiesForRole(role)),
    'X-Whiteboard-Board-Id': 'board-1',
  });
  const command = async (principal: Principal, action: string, values: Record<string, unknown> = {}, role: Role = 'editor') => {
    const response = await room.fetch(new Request('https://board-room/collaboration/commands', { method: 'POST', headers: as(principal, role), body: JSON.stringify({ action, operationId: `op-${operation += 1}`, ...values }) }));
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const read = async (principal: Principal, role: Role = 'editor') => {
    const response = await room.fetch(new Request('https://board-room/collaboration', { headers: as(principal, role) }));
    return await response.json() as Record<string, any>;
  };
  return { room, command, read, as };
}
