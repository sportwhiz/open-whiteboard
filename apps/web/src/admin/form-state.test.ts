import { describe, expect, it } from 'vitest';
import { bulkFailureMessage, bulkTargets, invalidLimit, policyFieldForError, saveBarMessage, shouldGuardLink } from './form-state';

describe('settings save bar', () => {
  it('shows a failed save in the bar and keeps the edits marked unsaved', () => {
    expect(saveBarMessage({ dirty: true, busy: false, error: 'Configure email before enabling magic links.' })).toEqual({
      tone: 'error', text: 'Configure email before enabling magic links. Your changes have not been saved.',
    });
  });
  it('never shows a stale success message beside new edits', () => {
    expect(saveBarMessage({ dirty: true, busy: false, notice: 'Policy saved.' })).toEqual({ tone: 'dirty', text: 'You have unsaved changes' });
    expect(saveBarMessage({ dirty: false, busy: false, notice: 'Policy saved.' })).toEqual({ tone: 'saved', text: 'Policy saved.' });
  });
  it('reports saving, discarding and the idle state', () => {
    expect(saveBarMessage({ dirty: true, busy: true, error: 'old' }).tone).toBe('busy');
    expect(saveBarMessage({ dirty: false, busy: false, discarded: true }).text).toBe('Changes discarded');
    expect(saveBarMessage({ dirty: false, busy: false }).text).toBe('No unsaved changes');
  });
});

describe('leave guard', () => {
  const link = (href: string, extra: { target?: string; download?: boolean } = {}) => ({
    href, target: extra.target ?? '', hasAttribute: (name: string) => name === 'download' && Boolean(extra.download),
  });
  const here = 'https://studio.example/settings/sign-in';
  it('guards every in-app page, not an allowlist', () => {
    for (const href of ['https://studio.example/', 'https://studio.example/settings/connections', 'https://studio.example/settings/people', 'https://studio.example/boards/b1'])
      expect(shouldGuardLink(link(href), here)).toBe(true);
  });
  it('leaves other origins, new tabs, downloads, APIs and same-page anchors alone', () => {
    expect(shouldGuardLink(link('https://elsewhere.example/'), here)).toBe(false);
    expect(shouldGuardLink(link('https://studio.example/', { target: '_blank' }), here)).toBe(false);
    expect(shouldGuardLink(link('https://studio.example/api/v1/export', { download: true }), here)).toBe(false);
    expect(shouldGuardLink(link('https://studio.example/api/v1/boards/b1/export'), here)).toBe(false);
    expect(shouldGuardLink(link('https://studio.example/settings/sign-in#providers'), here)).toBe(false);
  });
});

describe('save failures point at the field', () => {
  it('always separates the error from the unsaved note', () => {
    expect(saveBarMessage({ dirty: true, busy: false, error: 'Installation name is required (up to 40 characters)' }).text)
      .toBe('Installation name is required (up to 40 characters). Your changes have not been saved.');
  });
  it('maps policy errors to their field', () => {
    expect(policyFieldForError('Installation name is required (up to 80 characters).')).toBe('title');
    expect(policyFieldForError('Configure email before enabling magic links.')).toBe('magic_link');
    expect(policyFieldForError('Configure email before enabling public registration.')).toBe('registration');
    expect(policyFieldForError('Something else')).toBeNull();
  });
  it('finds the limit that is out of range', () => {
    const keys = ['member_limit', 'guest_limit'];
    expect(invalidLimit({ member_limit: 0, guest_limit: 5 }, keys)).toBe('member_limit');
    expect(invalidLimit({ member_limit: 3, guest_limit: -1 }, keys)).toBe('guest_limit');
    expect(invalidLimit({ member_limit: 3, guest_limit: 0 }, keys)).toBeNull();
  });
});

describe('bulk actions apply only where they make sense', () => {
  const people = [
    { id: 'a', status: 'pending_approval' }, { id: 'b', status: 'active' }, { id: 'c', status: 'suspended' }, { id: 'd', status: 'deleted' },
  ];
  it('approves only people waiting for approval', () => expect(bulkTargets(people, 'approve')).toEqual(['a']));
  it('suspends only people not already suspended', () => expect(bulkTargets(people, 'suspend')).toEqual(['a', 'b']));
  it('never acts on deleted accounts', () => expect(bulkTargets(people, 'secure')).toEqual(['a', 'b', 'c']));
});

describe('bulk failure messages', () => {
  it('say what happened and why, without an empty list', () => {
    expect(bulkFailureMessage('secure', 25, 30, ['Owner accounts are protected.', 'Owner accounts are protected.'])).toBe('Secured 25 of 30 people. 5 could not be secured: Owner accounts are protected. They are still selected.');
    expect(bulkFailureMessage('approve', 0, 1, [undefined])).toBe('Approved 0 of 1 person. 1 could not be approved. Try again. They are still selected.');
  });
});
