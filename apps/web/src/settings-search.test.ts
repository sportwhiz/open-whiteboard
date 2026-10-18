import { describe, expect, it } from 'vitest';
import { findSettingIndex, matchSettingsRoutes, matchSettingTargets, SETTING_TARGETS } from './settings-search';

const routes = [
  { path: '/settings/account', label: 'Account and security', keywords: 'password passkeys mfa two-factor 2fa email sessions' },
  { path: '/settings/connections', label: 'Connected apps', keywords: 'mcp chatgpt claude oauth' },
  { path: '/settings/people', label: 'People', keywords: 'users members invite suspend' },
  { path: '/settings/invitations', label: 'Invitations', keywords: 'invite invites email pending' },
  { path: '/settings/sign-in', label: 'Sign-in settings', keywords: 'password magic links email mfa registration' },
  { path: '/settings/usage', label: 'Usage and limits', keywords: 'quotas storage email per day' },
  { path: '/settings/system', label: 'System', keywords: 'email smtp mail setup' },
];
const paths = (query: string) => matchSettingsRoutes(routes, query).map(route => route.path);

describe('settings search', () => {
  it('matches topics people search for, not only titles', () => {
    expect(paths('invite')).toEqual(['/settings/invitations', '/settings/people']);
    expect(paths('password')).toEqual(['/settings/account', '/settings/sign-in']);
    expect(paths('mfa')).toEqual(['/settings/account', '/settings/sign-in']);
    expect(paths('email')).toContain('/settings/system');
  });
  it('ranks title matches first and matches word prefixes and phrases', () => {
    expect(paths('usage')[0]).toBe('/settings/usage');
    expect(paths('pass')).toEqual(['/settings/account', '/settings/sign-in']);
    expect(paths('sign-in')[0]).toBe('/settings/sign-in');
    expect(paths('email setup')).toEqual(['/settings/system']);
  });
  it('returns everything for an empty query and nothing for nonsense', () => {
    expect(paths('  ')).toHaveLength(routes.length);
    expect(paths('zzz')).toEqual([]);
  });
});

describe('finding a setting on its page', () => {
  const labels = ['Account and security', 'Email address', 'Password', 'Passkeys', 'Authenticator', 'Recovery codes', 'Devices and sessions'];
  it('goes to the row a search was for, including synonyms', () => {
    expect(findSettingIndex(labels, 'mfa')).toBe(4);
    expect(findSettingIndex(labels, 'password')).toBe(2);
    expect(findSettingIndex(labels, 'email')).toBe(1);
    expect(findSettingIndex(['Registration', 'Require a second factor for everyone', 'Allow email sign-in links'], 'mfa')).toBe(1);
    expect(findSettingIndex(['Registration', 'Allow email sign-in links'], 'magic')).toBe(1);
    expect(findSettingIndex(labels, 'zzz')).toBe(-1);
  });
});

describe('individual settings in search', () => {
  const labels = (query: string) => matchSettingTargets(SETTING_TARGETS, query).map(target => `${target.section} · ${target.label}`);
  it('finds every term people use, labelled by whose setting it is', () => {
    expect(labels('mfa')).toEqual(['Sign-in policy · Require a second factor', 'Your account · Authenticator app']);
    expect(labels('two-factor')).toEqual(labels('mfa'));
    expect(labels('delete account')).toEqual(['Your account · Delete account']);
    expect(labels('guest link')).toEqual(['Usage and limits · Guest limit']);
    expect(labels('theme')).toEqual(['Appearance · Theme: light, dark or system']);
    expect(labels('approve')).toEqual(['Sign-in policy · Approve new registrations', 'People · People awaiting approval']);
  });
  it('lands on the control: the find text exists on its page', () => {
    for (const target of SETTING_TARGETS.filter(item => !item.action)) {
      expect(findSettingIndex(['Unrelated heading', target.find], target.find)).toBe(1);
    }
  });
});
