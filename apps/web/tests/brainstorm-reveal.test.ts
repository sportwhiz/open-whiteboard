import { describe, expect, it, vi } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';

import { BoardRoom } from '../src/board-room';
import { createHeadlessBoard } from '../src/blocksuite/headless-board';
import { captureNativeSnapshot } from '../src/blocksuite/runtime/snapshot';
import {
  parseBounds,
  placeRevealFrame,
  REVEAL_CLEARANCE,
  revealBatches,
  revealGrid,
  revealNotePosition,
  revealOrigin,
  type Rect,
} from '../src/brainstorm-placement';
import { capabilitiesForRole, type Principal } from '../src/collaboration-types';
import { applyNativeOperations, readNativeBoard } from '../src/native-operations.server';
import { createRoomStorage } from '../src/node/rooms';
import { UNREADABLE_COLLABORATION_MESSAGE } from '../src/collaboration-archive.server';
import { emptyCollaborationState, type RoomCollaborationState } from '../src/room-collaboration';

const intersects = (a: Rect, b: Rect, clearance = 0) =>
  a.x < b.x + b.width + clearance && b.x < a.x + a.width + clearance &&
  a.y < b.y + b.height + clearance && b.y < a.y + a.height + clearance;

describe('brainstorm reveal placement', () => {
  it('lays ideas out as a tidy grid inside the frame', () => {
    const grid = revealGrid(7);
    expect(grid.columns).toBe(4);
    expect(grid.rows).toBe(2);
    const origin = { x: 1000, y: 200 };
    const notes = Array.from({ length: 7 }, (_, index) => ({ ...revealNotePosition(origin, index, grid.columns), width: 208, height: 208 }));
    for (const note of notes) {
      expect(note.x).toBeGreaterThanOrEqual(origin.x);
      expect(note.y).toBeGreaterThanOrEqual(origin.y);
      expect(note.x + note.width).toBeLessThanOrEqual(origin.x + grid.width);
      expect(note.y + note.height).toBeLessThanOrEqual(origin.y + grid.height);
    }
    for (let a = 0; a < notes.length; a += 1) for (let b = a + 1; b < notes.length; b += 1) expect(intersects(notes[a], notes[b])).toBe(false);
    expect(revealGrid(3)).toMatchObject({ columns: 3, rows: 1 });
    expect(revealGrid(1)).toMatchObject({ columns: 1, rows: 1 });
  });

  it('uses the facilitator view when it is clear', () => {
    const size = revealGrid(2);
    const occupied = [{ x: 0, y: 0, width: 400, height: 300 }];
    const point = placeRevealFrame(size, occupied, { x: 3000, y: 3000 });
    expect(point).toEqual({ x: Math.round(3000 - size.width / 2), y: Math.round(3000 - size.height / 2) });
  });

  it('never overlaps existing content when the view is busy', () => {
    const size = revealGrid(4);
    const occupied = [
      { x: -100, y: -100, width: 900, height: 500 },
      { x: 0, y: 0, width: 208, height: 208 },
      { x: 260, y: 0, width: 208, height: 208 },
    ];
    const point = placeRevealFrame(size, occupied, { x: 300, y: 100 });
    for (const rect of occupied) expect(intersects({ ...point, ...size }, rect, REVEAL_CLEARANCE)).toBe(false);
  });

  it('goes beside existing content when nothing nearby is clear, and never to (100,100)', () => {
    const size = revealGrid(3);
    // A dense wall of content around the view.
    const occupied: Rect[] = [];
    for (let x = -6000; x <= 6000; x += 400) for (let y = -6000; y <= 6000; y += 400) occupied.push({ x, y, width: 380, height: 380 });
    const point = placeRevealFrame(size, occupied, { x: 0, y: 0 });
    for (const rect of occupied) expect(intersects({ ...point, ...size }, rect)).toBe(false);
    expect(point.x > 6380 || point.y > 6380).toBe(true);
    expect(placeRevealFrame(size, [{ x: 0, y: 0, width: 300, height: 300 }])).toEqual({ x: 300 + REVEAL_CLEARANCE, y: 0 });
  });

  it('ignores malformed geometry', () => {
    expect(parseBounds('[1,2,3,4]')).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(parseBounds('[0,0,0,0]')).toBeNull();
    expect(parseBounds('nope')).toBeNull();
    expect(parseBounds(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The same BoardRoom runs inside a Cloudflare Durable Object and inside the
// Node.js server (MySQL-backed room storage). Exercise both.

import { catalog, durableObjectStorage, header, mysqlConnection, owner, type Storage } from './room-harness';

async function revealOn(storage: Storage, values: Record<string, unknown>, ideas = ['Peer idea one', 'Peer idea two', 'Owner idea']) {
  const board = createHeadlessBoard([], 'reveal-test', { includeFrames: false });
  const empty = captureNativeSnapshot(board.workspace);
  board.workspace.dispose();
  // The same layout as the reported bug: a frame with stickies near the origin.
  const seeded = applyNativeOperations(empty, [
    { type: 'create_frame', ref: 'ideas', title: 'Ideas', x: -100, y: -100, width: 900, height: 500 },
    { type: 'create_note', text: 'Faster onboarding', x: 0, y: 0 },
    { type: 'create_note', text: 'Dark mode polish', x: 260, y: 0 },
    { type: 'create_note', text: 'Offline sync', x: 520, y: 0 },
  ]).snapshot;
  await storage.put('board', { revision: 1, updatedAt: new Date().toISOString(), documentEpoch: 'epoch', snapshot: seeded });
  const collaboration: RoomCollaborationState = emptyCollaborationState();
  const timestamp = new Date().toISOString();
  collaboration.brainstorm = {
    id: 'brainstorm:1', status: 'closed', title: 'Silent brainstorm', instructions: '', startedBy: 'owner', startedAt: timestamp,
    endsAt: null, closedAt: timestamp, revealedAt: null, revealedIds: [],
    drafts: Object.fromEntries(ideas.map((text, index) => [`draft:${index}`, {
      id: `draft:${index}`, authorId: index ? 'owner' : 'peer', text, color: 'yellow' as const, x: 0, y: 0, submittedAt: timestamp, updatedAt: timestamp,
    }])),
  };
  await storage.put('collaboration', collaboration);
  const room = new BoardRoom({ storage, getWebSockets: () => [] } as unknown as DurableObjectState, { CATALOG: catalog });
  const response = await room.fetch(new Request('https://board-room/collaboration/commands', {
    method: 'POST',
    headers: {
      'X-Whiteboard-Principal': header(owner),
      'X-Whiteboard-Capabilities': header(capabilitiesForRole('owner')),
      'X-Whiteboard-Board-Id': 'board-1',
    },
    body: JSON.stringify({ action: 'reveal_brainstorm', operationId: 'reveal-1', ...Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'expectError')) }),
  }));
  const result = await response.json() as { revealedArea?: Rect; error?: string; state: { brainstorm: { revealedArea?: Rect; status: string; revealedIds: string[] } } };
  if (values.expectError) return { result, status: response.status, semantic: null as never, seeded: null as never };
  expect(result.error).toBeUndefined();
  const stored = await storage.get<{ snapshot: Parameters<typeof readNativeBoard>[0] }>('board');
  return { result, semantic: readNativeBoard(stored!.snapshot), seeded: readNativeBoard(seeded) };
}

describe.each([
  ['Cloudflare Durable Object', () => durableObjectStorage()],
  ['Node.js room storage', () => createRoomStorage(mysqlConnection() as unknown as PoolConnection, 'board:board-1') as unknown as Storage],
])('reveal_brainstorm on %s', (_name, storage) => {
  it('places revealed ideas in open space near the facilitator and reports where', async () => {
    const { result, semantic, seeded } = await revealOn(storage(), { nearX: 300, nearY: 100 });
    const area = result.revealedArea!;
    expect(area).toBeDefined();
    expect(result.state.brainstorm.status).toBe('revealed');
    expect(result.state.brainstorm.revealedArea).toEqual(area);
    const existing = seeded.elements.map(element => parseBounds(element.xywh)).filter((rect): rect is Rect => rect !== null);
    for (const rect of existing) expect(intersects(area, rect)).toBe(false);
    const revealed = semantic.notes.filter(note => note.text.includes('idea'));
    expect(revealed).toHaveLength(3);
    for (const note of revealed) {
      const bounds = parseBounds(note.xywh)!;
      expect(bounds.x).toBeGreaterThanOrEqual(area.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width);
      for (const rect of existing) expect(intersects(bounds, rect)).toBe(false);
    }
    expect(semantic.frames.some(frame => frame.title === 'Silent brainstorm' && frame.childIds.length === 3)).toBe(true);
  });

  it('keeps explicit coordinates for API callers', async () => {
    const { result } = await revealOn(storage(), { x: 4000, y: 4000 });
    expect(result.revealedArea).toMatchObject({ x: 4000, y: 4000 });
  });

  it('keeps the frame inside the native coordinate range', async () => {
    const { result } = await revealOn(storage(), { x: 5e9, y: -5e9 });
    const area = result.revealedArea!;
    expect(area.x + area.width).toBeLessThanOrEqual(1_000_000);
    expect(area.y).toBe(-1_000_000);
    const near = await revealOn(storage(), { nearX: 1e12, nearY: 1e12 });
    expect(near.result.revealedArea!.x + near.result.revealedArea!.width).toBeLessThanOrEqual(1_000_000);
  });

  it('explains a half-given position instead of guessing', async () => {
    const { result, status } = await revealOn(storage(), { x: 100, expectError: true });
    expect(status).toBe(400);
    expect(result.error).toBe('Give both x and y for the revealed ideas, or neither to place them automatically.');
  });

  it('reveals more ideas than one native batch holds', async () => {
    const ideas = Array.from({ length: 150 }, (_, index) => `Idea ${index + 1}`);
    const { result, semantic } = await revealOn(storage(), {}, ideas);
    const frame = semantic.frames.find(item => item.title === 'Silent brainstorm')!;
    expect(frame.childIds).toHaveLength(150);
    expect(result.state.brainstorm.revealedIds).toHaveLength(151);
    expect(result.state.brainstorm.revealedIds[0]).toBe(frame.id);
    expect(semantic.notes.filter(note => note.text.startsWith('Idea '))).toHaveLength(150);
  });
});

it('places ideas identically on both runtimes', async () => {
  const durable = await revealOn(durableObjectStorage(), { nearX: 300, nearY: 100 });
  const node = await revealOn(createRoomStorage(mysqlConnection() as unknown as PoolConnection, 'board:board-1') as unknown as Storage, { nearX: 300, nearY: 100 });
  expect(node.result.revealedArea).toEqual(durable.result.revealedArea);
});

describe('reveal helpers', () => {
  it('batches a frame and its notes into native-sized operation lists', () => {
    const batches = revealBatches('frame', Array.from({ length: 250 }, (_, index) => index));
    expect(batches.map(batch => batch.length)).toEqual([100, 100, 51]);
    expect(batches[0][0]).toBe('frame');
    expect(batches.flat()).toHaveLength(251);
  });
  it('keeps the largest allowed brainstorm within native frame limits', () => {
    const grid = revealGrid(500);
    expect(grid.width).toBeLessThanOrEqual(20_000);
    expect(grid.height).toBeLessThanOrEqual(20_000);
    expect(revealOrigin({ x: -2e6, y: 2e6 }, grid, () => [])).toEqual({ x: -1_000_000, y: 1_000_000 - grid.height });
  });
});

describe.each([
  ['Cloudflare Durable Object', () => durableObjectStorage()],
  ['Node.js room storage', () => createRoomStorage(mysqlConnection() as unknown as PoolConnection, 'board:board-1') as unknown as Storage],
])('unreadable collaboration state on %s', (_name, makeStorage) => {
  const command = (room: BoardRoom, action: string, operationId: string) => room.fetch(new Request('https://board-room/collaboration/commands', {
    method: 'POST',
    headers: { 'X-Whiteboard-Principal': header(owner), 'X-Whiteboard-Capabilities': header(capabilitiesForRole('owner')), 'X-Whiteboard-Board-Id': 'board-1' },
    body: JSON.stringify({ action, operationId }),
  }));
  const board = async (storage: Storage) => {
    const fixture = createHeadlessBoard([], 'unreadable-test', { includeFrames: false });
    await storage.put('board', { revision: 1, updatedAt: new Date().toISOString(), documentEpoch: 'epoch', snapshot: captureNativeSnapshot(fixture.workspace) });
    fixture.workspace.dispose();
  };

  it('refuses to write over stored state it cannot read, and keeps it intact', async () => {
    const storage = makeStorage();
    await board(storage);
    // For example, state written by a newer version with fields this one rejects.
    const future = { ...emptyCollaborationState(), comments: [{ id: 'thread:1', anchor: { x: 0, y: 0, objectId: null }, createdBy: 'owner', createdAt: 'now', resolvedAt: null, resolvedBy: null, replies: [], future: true }], revision: 'v2' };
    await storage.put('collaboration', future);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const room = new BoardRoom({ storage, getWebSockets: () => [] } as unknown as DurableObjectState, { CATALOG: catalog });
    const response = await command(room, 'raise_hand', 'hand-1');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'COLLABORATION_UNREADABLE', error: UNREADABLE_COLLABORATION_MESSAGE });
    expect(await storage.get('collaboration')).toEqual(future);
    const exported = await room.fetch(new Request('https://board-room/collaboration-archive', { headers: { 'X-Whiteboard-Principal': header(owner), 'X-Whiteboard-Capabilities': header(capabilitiesForRole('owner')), 'X-Whiteboard-Board-Id': 'board-1' } }));
    expect(exported.status).toBe(409);
    await room.alarm();
    expect(await storage.get('collaboration')).toEqual(future);
    expect(errors).toHaveBeenCalledWith('Stored collaboration state could not be parsed; writes to it are refused.');
    errors.mockRestore();
  });

  it('still starts a genuinely empty room', async () => {
    const storage = makeStorage();
    await board(storage);
    const room = new BoardRoom({ storage, getWebSockets: () => [] } as unknown as DurableObjectState, { CATALOG: catalog });
    const response = await command(room, 'raise_hand', 'hand-1');
    expect(response.status).toBe(200);
    expect(Object.keys((await storage.get<RoomCollaborationState>('collaboration'))!.raisedHands)).toEqual(['owner']);
  });
});
