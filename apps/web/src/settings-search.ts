/** Settings navigation search: match what people type, not only section titles. */
export type SearchableSettingsRoute = { path: string; label: string; keywords?: string };

const normalize = (value: string) => value.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/gu, '');
const words = (value: string) => normalize(value).split(/[^a-z0-9]+/u).filter(Boolean);
/** Prefix match that tolerates a final letter ("invite" finds "invitations"). */
const matchesWord = (word: string, term: string) => word.startsWith(term) || (term.length >= 5 && word.startsWith(term.slice(0, -1)));

/**
 * Every typed word must match the start of a word in the section title or its
 * keywords ("pass" finds "password", "invite" finds "Invitations"). Sections
 * whose title matches come first, then keyword matches, in original order.
 */
export function matchSettingsRoutes<T extends SearchableSettingsRoute>(routes: T[], query: string): T[] {
  const terms = words(query);
  if (!terms.length) return routes;
  const scored = routes.map((route, index) => {
    const title = words(route.label);
    const vocabulary = [...title, ...words(route.keywords ?? '')];
    const joinedTitle = normalize(route.label);
    if (!terms.every(term => vocabulary.some(word => matchesWord(word, term)) || joinedTitle.includes(term))) return null;
    const titleHits = terms.filter(term => title.some(word => matchesWord(word, term)) || joinedTitle.includes(term)).length;
    return { route, index, score: titleHits === terms.length ? 0 : titleHits ? 1 : 2 };
  }).filter((item): item is { route: T; index: number; score: number } => item !== null);
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map(item => item.route);
}

/** Words a setting is labelled with, for terms people search for. */
const PHRASES: Record<string, string[]> = {
  mfa: ['second factor', 'authenticator', 'two-factor'],
  '2fa': ['second factor', 'authenticator', 'two-factor'],
  'two-factor': ['two-factor', 'second factor', 'authenticator'],
  otp: ['authenticator'],
  authenticator: ['authenticator'],
  passkey: ['passkey'],
  passkeys: ['passkey'],
  password: ['password'],
  invite: ['invit'],
  invites: ['invit'],
  invitation: ['invit'],
  magic: ['sign-in links', 'magic'],
  session: ['sign out after', 'new sign-in after', 'session'],
  sessions: ['sessions', 'devices'],
  timeout: ['sign out after'],
  smtp: ['email'],
  mail: ['email'],
  limits: ['limit'],
  quota: ['limit'],
  quotas: ['limit'],
  sso: ['provider'],
  oidc: ['provider'],
  github: ['provider', 'github'],
  google: ['provider', 'google'],
};

/**
 * Pick the setting on the page that a search was for. `labels` are the
 * visible texts of headings, field labels and rows, in page order. Returns
 * the index of the best match, or -1.
 */
export function findSettingIndex(labels: string[], query: string) {
  const terms = words(query);
  if (!terms.length) return -1;
  const phrases = [...new Set(terms.flatMap(term => [...(PHRASES[term] ?? []), term]))];
  let best = -1;
  let bestScore = 0;
  labels.forEach((label, index) => {
    const text = normalize(label);
    const score = phrases.reduce((total, phrase, rank) => total + (text.includes(phrase) ? phrases.length - rank : 0), 0);
    if (score > bestScore) { best = index; bestScore = score; }
  });
  return best;
}

/**
 * Individual settings people search for, so a search lands on the control
 * itself. `find` is the visible text (or accessible name) of the control's
 * row; `section` says whose setting it is when a word means both a personal
 * and a policy setting ("Your account" vs "Sign-in policy").
 */
export type SettingTarget = { path: string; section: string; label: string; find: string; keywords: string; action?: 'theme' };
export const SETTING_TARGETS: SettingTarget[] = [
  { path: '/settings/sign-in', section: 'Sign-in policy', label: 'Require a second factor', find: 'Require a second factor', keywords: 'mfa 2fa two-factor two factor second factor otp totp policy require enforce' },
  { path: '/settings/account', section: 'Your account', label: 'Authenticator app', find: 'Authenticator', keywords: 'mfa 2fa two-factor two factor second factor otp totp authenticator app' },
  { path: '/settings/account', section: 'Your account', label: 'Passkeys', find: 'Passkeys', keywords: 'passkey passkeys webauthn face id touch id security key' },
  { path: '/settings/account', section: 'Your account', label: 'Password', find: 'Password', keywords: 'password change password' },
  { path: '/settings/account', section: 'Your account', label: 'Recovery codes', find: 'Recovery codes', keywords: 'recovery codes backup codes' },
  { path: '/settings/account', section: 'Your account', label: 'Email address', find: 'Email address', keywords: 'email address change email' },
  { path: '/settings/account', section: 'Your account', label: 'Devices and sessions', find: 'Devices and sessions', keywords: 'devices sessions sign out log out' },
  { path: '/settings/account', section: 'Your account', label: 'Export your data', find: 'Export account information', keywords: 'export download data gdpr' },
  { path: '/settings/account', section: 'Your account', label: 'Delete account', find: 'Delete account', keywords: 'delete account remove account close account' },
  { path: '/settings/sign-in', section: 'Sign-in policy', label: 'Approve new registrations', find: 'Approve new public registrations', keywords: 'approve approval registration signup' },
  { path: '/settings/people', section: 'People', label: 'People awaiting approval', find: 'Account status', keywords: 'approve approval pending waiting' },
  { path: '/settings/sign-in', section: 'Sign-in policy', label: 'Email sign-in links', find: 'Allow email sign-in links', keywords: 'magic link email sign-in links' },
  { path: '/settings/sign-in', section: 'Sign-in policy', label: 'Registration', find: 'Registration', keywords: 'registration signup sign up public invite only' },
  { path: '/settings/sign-in', section: 'Sign-in policy', label: 'Sign out after inactivity', find: 'Sign out after inactivity', keywords: 'session timeout idle inactivity' },
  { path: '/settings/usage', section: 'Usage and limits', label: 'Guest limit', find: 'Guests', keywords: 'guest guests guest link guest links limit' },
  { path: '', section: 'Appearance', label: 'Theme: light, dark or system', find: '', keywords: 'theme dark mode light mode appearance colour color', action: 'theme' },
];

/** Settings matching a query, best first (every word must match). */
export function matchSettingTargets(targets: SettingTarget[], query: string) {
  const terms = words(query);
  if (!terms.length) return [];
  return targets.map((target, index) => {
    const vocabulary = [...words(target.label), ...words(target.keywords)];
    const joined = normalize(`${target.label} ${target.keywords}`);
    if (!terms.every(term => vocabulary.some(word => matchesWord(word, term)) || joined.includes(term))) return null;
    const exact = terms.every(term => words(target.label).some(word => matchesWord(word, term)));
    return { target, index, score: exact ? 0 : 1 };
  }).filter((item): item is { target: SettingTarget; index: number; score: number } => item !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index).map(item => item.target);
}
