import { z } from 'zod';

import { emptyCollaborationState, type RoomCollaborationState } from './room-collaboration';

const actorSchema = z.object({ id: z.string(), name: z.string(), color: z.string() });
const commentReplySchema = z.object({
  id: z.string(), author: actorSchema, body: z.string(), mentions: z.array(z.string()),
  createdAt: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable(),
});
const collaborationArchiveSchema = z.object({
  revision: z.number().int().nonnegative(),
  comments: z.array(z.object({
    id: z.string(),
    anchor: z.object({ x: z.number(), y: z.number(), objectId: z.string().nullable() }),
    createdBy: z.string(), createdAt: z.string(), resolvedAt: z.string().nullable(),
    resolvedBy: z.string().nullable(), replies: z.array(commentReplySchema),
  })),
  timer: z.object({
    status: z.enum(['running', 'paused', 'ended']), label: z.string(), startedBy: z.string(),
    startedAt: z.string(), endsAt: z.string().nullable(), remainingMs: z.number(),
  }).nullable(),
  voteRounds: z.array(z.object({
    id: z.string(), status: z.enum(['running', 'ended']), title: z.string(), targets: z.array(z.string()),
    votesPerUser: z.number().int(), maxPerTarget: z.number().int(), anonymous: z.boolean(),
    startedBy: z.string(), startedAt: z.string(), endsAt: z.string().nullable(), endedAt: z.string().nullable(),
    ballots: z.record(z.array(z.string())), ballotNames: z.record(z.string()).optional(),
  })),
  brainstorm: z.object({
    id: z.string(), status: z.enum(['running', 'closed', 'revealed', 'cancelled']), title: z.string(),
    instructions: z.string(), startedBy: z.string(), startedAt: z.string(), endsAt: z.string().nullable(),
    closedAt: z.string().nullable(), revealedAt: z.string().nullable(),
    drafts: z.record(z.object({
      id: z.string(), authorId: z.string(), text: z.string(),
      // Unknown colors (from a newer release) fall back instead of invalidating
      // the whole archive, so rollbacks never discard collaboration state.
      color: z.enum(['yellow', 'orange', 'green', 'blue', 'purple']).catch('yellow'),
      x: z.number(), y: z.number(), submittedAt: z.string().nullable(), updatedAt: z.string(),
    })),
    revealedIds: z.array(z.string()),
    revealedArea: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().optional(),
  }).nullable(),
  presentation: z.object({
    id: z.string(), status: z.enum(['running', 'ended']), presenterId: z.string(),
    frameIds: z.array(z.string()), frameIndex: z.number().int(),
    viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).nullable(), updatedAt: z.string(),
    // Optional so older and newer versions read each other's state.
    presenterLeftAt: z.string().nullable().optional(),
    endedReason: z.enum(['presenter-left']).nullable().optional().catch(null),
  }).nullable(),
  raisedHands: z.record(z.string()),
  checkpoints: z.array(z.object({
    id: z.string(), revision: z.number().int(), label: z.string(), createdBy: z.string(), createdAt: z.string(),
  })),
  activity: z.array(z.object({
    id: z.string(), actor: actorSchema, kind: z.string(), summary: z.string(), createdAt: z.string(),
  })),
  // Optional: older versions strip it, and state written by them still parses.
  facilitatorId: z.string().nullable().optional(),
});

export function parseCollaborationArchive(value: unknown): RoomCollaborationState | null {
  const parsed = collaborationArchiveSchema.safeParse(value);
  return parsed.success ? parsed.data as RoomCollaborationState : null;
}

export const UNREADABLE_COLLABORATION_MESSAGE = 'This board’s comments and workshop history could not be read, so changes to them are paused to keep them safe. Ask an administrator to restore the board from a backup.';

/** Thrown instead of writing over stored collaboration state that did not parse. */
export class UnreadableCollaborationError extends Error {
  constructor() { super(UNREADABLE_COLLABORATION_MESSAGE); this.name = 'UnreadableCollaborationError'; }
}

/**
 * Read a room's stored collaboration state. An empty room starts fresh, but a
 * stored value that fails to parse (for example one written by a newer
 * version) is reported as unreadable, never replaced by an empty state:
 * the next write would otherwise erase its comments, votes and activity.
 */
export function readStoredCollaboration(stored: unknown): { state: RoomCollaborationState; readable: boolean } {
  if (stored === undefined || stored === null) return { state: emptyCollaborationState(), readable: true };
  const parsed = parseCollaborationArchive(stored);
  if (parsed) return { state: parsed, readable: true };
  // A fixed message: the stored value may hold private comment text.
  console.error('Stored collaboration state could not be parsed; writes to it are refused.');
  return { state: emptyCollaborationState(), readable: false };
}
