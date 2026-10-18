import { describe, expect, it } from 'vitest';
import { groupSecurityEvents, relativeTime, securityEventLabel, securityEventPeople, type SecurityEvent } from './security-event-label';

const event = (id: string, action: string, at: string, actor: string | null, target: string | null, names: Record<string, string> = {}): SecurityEvent => ({
  id, action, created_at: at, actor_id: actor, target_id: target, outcome: 'success', metadata: '{}', actor_name: actor ? names[actor] : null, target_name: target ? names[target] : null,
});

describe('security activity', () => {
  it('merges the two records one role change writes', () => {
    const rows = groupSecurityEvents([
      event('2', 'admin.role_changed', '2026-10-18T16:31:30.500Z', 'owner', 'mia'),
      event('1', 'admin.role', '2026-10-18T16:31:30.000Z', 'owner', 'mia'),
      event('0', 'auth.sign-in.local', '2026-10-18T16:29:34.000Z', 'mia', null),
    ]);
    expect(rows.map(row => [row.action, row.merged])).toEqual([['admin.role_changed', 2], ['auth.sign-in.local', undefined]]);
    expect(securityEventLabel('admin.role_changed')).toBe('Role changed');
  });
  it('reads a new account as one event, not "password added and access revoked"', () => {
    const rows = groupSecurityEvents([
      event('b', 'account.password_added', '2026-10-18T15:57:55.000Z', 'new', 'new'),
      event('a', 'auth.setup.local', '2026-10-18T15:57:55.000Z', 'new', 'new'),
    ]);
    expect(rows).toHaveLength(1);
    expect(securityEventLabel(rows[0].action)).toBe('Local account created');
    expect(securityEventLabel('account.password_added')).toBe('Password added');
  });
  it('keeps unrelated or distant events apart', () => {
    expect(groupSecurityEvents([
      event('2', 'admin.role_changed', '2026-10-18T16:31:30.000Z', 'owner', 'mia'),
      event('1', 'admin.role', '2026-10-18T16:21:30.000Z', 'owner', 'mia'),
    ])).toHaveLength(2);
  });
  it('says who did it to whom, and when', () => {
    const names = { owner: 'Olive Owner', mia: 'Mia Member' };
    expect(securityEventPeople(event('1', 'admin.role', 'x', 'owner', 'mia', names))).toBe('Olive Owner → Mia Member');
    expect(securityEventPeople(event('1', 'admin.role', 'x', 'owner', 'mia', names), 'owner')).toBe('You → Mia Member');
    expect(securityEventPeople(event('1', 'auth.sign-in.local', 'x', 'mia', 'mia', names))).toBe('Mia Member');
    expect(securityEventPeople(event('1', 'auth.sign-in.local', 'x', null, null))).toBe('Unauthenticated request');
    const now = Date.parse('2026-10-18T17:00:00Z');
    expect(relativeTime('2026-10-18T16:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-10-18T16:55:00Z', now)).toBe('5 min ago');
    expect(relativeTime('2026-10-18T14:00:00Z', now)).toBe('3 h ago');
  });
});
