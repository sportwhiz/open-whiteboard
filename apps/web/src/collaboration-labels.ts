import type { RoomParticipant } from './room-collaboration';

/** Plain-language labels for collaboration UI. Pure, so they are unit tested. */
export type SemanticItem = { id: string; text?: string; title?: string; xywh?: string };
export type SemanticBoard = { notes: SemanticItem[]; frames: SemanticItem[]; shapes?: SemanticItem[]; texts?: SemanticItem[]; images?: SemanticItem[] };
export type Anchor = { x: number; y: number; objectId: string | null };

export const quote = (value: string, length = 42) => {
  const text = value.replace(/\s+/gu, ' ').trim();
  return `“${text.length > length ? `${text.slice(0, length - 1)}…` : text}”`;
};

/** A readable name for what a comment is pinned to, never raw coordinates. */
export function anchorLabel(objectId: string | null, board: SemanticBoard) {
  // Placed at a spot on the board, not attached to an object.
  if (!objectId) return 'Board comment';
  const note = board.notes.find(item => item.id === objectId);
  if (note) return note.text?.trim() ? `On sticky ${quote(note.text)}` : 'On a sticky note';
  const frame = board.frames.find(item => item.id === objectId);
  if (frame) return frame.title?.trim() ? `On frame ${quote(frame.title)}` : 'On a frame';
  const shape = board.shapes?.find(item => item.id === objectId);
  if (shape) return shape.text?.trim() ? `On shape ${quote(shape.text)}` : 'On a shape';
  const text = board.texts?.find(item => item.id === objectId);
  if (text) return text.text?.trim() ? `On text ${quote(text.text)}` : 'On a text block';
  if (board.images?.some(item => item.id === objectId)) return 'On an image';
  return 'On a board object';
}

/**
 * The board object under a comment's anchor point: the smallest sticky,
 * shape, text or image containing it, otherwise the smallest frame.
 */
export function objectAt(point: { x: number; y: number }, board: SemanticBoard) {
  const bounds = (value?: string) => {
    try {
      const box = JSON.parse(value ?? '') as unknown;
      return Array.isArray(box) && box.length === 4 && box.every(item => typeof item === 'number') ? box as [number, number, number, number] : null;
    } catch { return null; }
  };
  const hits = [
    ...[...board.notes, ...(board.shapes ?? []), ...(board.texts ?? []), ...(board.images ?? [])].map(item => ({ item, rank: 0 })),
    ...board.frames.map(item => ({ item, rank: 1 })),
  ].flatMap(({ item, rank }) => {
    const box = bounds(item.xywh);
    return box && point.x >= box[0] && point.x <= box[0] + box[2] && point.y >= box[1] && point.y <= box[1] + box[3] ? [{ id: item.id, rank, area: box[2] * box[3] }] : [];
  }).sort((a, b) => a.rank - b.rank || a.area - b.area);
  return hits[0]?.id ?? null;
}

/** Describe where a comment is pinned, by object when there is one. */
export function describeAnchor(anchor: Anchor, board: SemanticBoard) {
  return anchorLabel(anchor.objectId ?? objectAt(anchor, board), board);
}

/** Distinct people, in arrival order, however many tabs each has open. */
export function uniqueParticipants(participants: RoomParticipant[]) {
  const people = new Map<string, RoomParticipant & { connections: number }>();
  for (const person of participants) {
    const existing = people.get(person.id);
    if (existing) {
      existing.connections += 1;
      if (existing.idle && !person.idle) existing.idle = false;
    } else people.set(person.id, { ...person, connections: 1 });
  }
  return [...people.values()];
}


/** Distinct people who have at least one connection allowed to vote. */
export function eligibleVoterIds(participants: Pick<RoomParticipant, 'id' | 'role'>[]) {
  return new Set(participants.filter(person => person.role !== 'viewer').map(person => person.id));
}
