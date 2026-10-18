import { useCallback, useRef, useState } from 'react';
import { apiFetch } from './auth-client';
import type { PublicCollaborationState } from './room-collaboration';

export type CommandResult = { error?: string; revealedArea?: { x: number; y: number; width: number; height: number }; state?: PublicCollaborationState };
export type CommandValues = Record<string, unknown> | ((latest: PublicCollaborationState) => Record<string, unknown> | null);
type Send = (action: string, values: Record<string, unknown>) => Promise<CommandResult>;

/** Send one collaboration command; throws with the server's message on failure. */
export async function sendCollaborationCommand(boardId: string, action: string, values: Record<string, unknown> = {}) {
  const response = await apiFetch(`/api/v1/boards/${encodeURIComponent(boardId)}/collaboration/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, operationId: crypto.randomUUID(), ...values }),
  });
  const result = await response.json().catch(() => ({})) as CommandResult;
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result;
}

/**
 * Commands run one at a time, in order, so quick successive actions (submit
 * one idea, delete another) all apply instead of being dropped. An identical
 * request already waiting or running is ignored (double clicks). Values given
 * as a function are computed when their turn comes, from the freshest state
 * seen (a command result arrives before the room broadcast), so two quick
 * votes add up instead of the second replacing the first.
 */
export class CommandQueue {
  latest: PublicCollaborationState;
  private tail: Promise<unknown> = Promise.resolve();
  private keys = new Set<string>();
  private waiting = 0;
  constructor(initial: PublicCollaborationState, private send: Send, private events: { pending?: (busy: boolean) => void; error?: (message: string) => void } = {}) {
    this.latest = initial;
  }
  observe(state: PublicCollaborationState) {
    if (state.revision >= this.latest.revision) this.latest = state;
  }
  run(action: string, values: CommandValues = {}): Promise<CommandResult | null> {
    const key = typeof values === 'function' ? null : JSON.stringify([action, values]);
    if (key && this.keys.has(key)) return Promise.resolve(null);
    if (key) this.keys.add(key);
    // A new burst of commands starts with a clean error; failures within a
    // burst are kept so the next queued command cannot wipe them.
    if (this.waiting === 0) this.events.error?.('');
    this.waiting += 1;
    this.events.pending?.(true);
    const run = async () => {
      try {
        const resolved = typeof values === 'function' ? values(this.latest) : values;
        if (!resolved) return null;
        const result = await this.send(action, resolved);
        if (result.state) this.observe(result.state);
        return result;
      } catch (failure) {
        this.events.error?.(failure instanceof Error ? failure.message : 'The action could not be completed. Try again.');
        return null;
      } finally {
        if (key) this.keys.delete(key);
        this.waiting -= 1;
        if (!this.waiting) this.events.pending?.(false);
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result;
    return result;
  }
}

/** A ballot change applied to your latest ballot in the running round. */
export function voteValues(change: (votes: string[]) => string[]) {
  return (latest: PublicCollaborationState) => {
    const round = latest.voteRounds.find(item => item.status === 'running');
    return round ? { roundId: round.id, targets: change(round.myVotes) } : null;
  };
}

export function useCollaborationCommands(boardId: string, state: PublicCollaborationState) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const queue = useRef<CommandQueue | null>(null);
  queue.current ??= new CommandQueue(state, (action, values) => sendCollaborationCommand(boardId, action, values), { pending: setPending, error: setError });
  queue.current.observe(state);
  const command = useCallback((action: string, values: CommandValues = {}) => queue.current!.run(action, values), []);
  return { command, pending, error, setError };
}
