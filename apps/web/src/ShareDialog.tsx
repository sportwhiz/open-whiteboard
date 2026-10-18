import { apiFetch } from "./auth-client";
import { UiIcon } from "./UiIcon";
import { useDialogFocus } from "./useDialogFocus";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import type { Capabilities, Collaborator, PendingInvitation, Role, SharePerson, ShareResult } from './collaboration-types';
import { avatarInk } from './avatar-color';
import { GuestSharing } from './GuestSharing';
import './share-dialog.css';

type ShareState = {
  capabilities: Capabilities;
  private?: boolean;
  collaborators: Collaborator[];
  invitations: PendingInvitation[];
};
type ShareRole = Exclude<Role, 'owner'>;
/** Who the "Add people" field will share with. */
type Recipient = { kind: 'person'; person: SharePerson } | { kind: 'email'; email: string };
type Confirmation =
  | { kind: 'remove'; person: Collaborator; trigger: HTMLElement | null }
  | { kind: 'revoke'; invitation: PendingInvitation; trigger: HTMLElement | null };

const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', editor: 'Editor', commenter: 'Commenter', viewer: 'Viewer' };
const ROLE_VERB: Record<ShareRole, string> = { editor: 'edit', commenter: 'comment', viewer: 'view' };
const ROLE_ABILITY: Record<Role, string> = { owner: 'manage it', editor: 'edit it', commenter: 'comment on it', viewer: 'view it' };
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const SEARCH_DELAY = 180;

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function api(path: string, init?: RequestInit) {
  const response = await apiFetch(path, init);
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new RequestError(body.error ?? `Request failed (${response.status})`, response.status);
  return body;
}

const message = (value: unknown, fallback: string) => value instanceof Error ? value.message : fallback;
const firstName = (name: string) => name.trim().split(/\s+/u)[0] || name;
function initials(name: string) {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? words.at(-1)![0] : '')).toUpperCase() || '?';
}

function Avatar({ name, color }: { name: string; color: string }) {
  return <span className="person-avatar" aria-hidden="true" style={{ background: color, color: avatarInk(color) }}>{initials(name)}</span>;
}

function accessLabel(person: SharePerson) {
  if (!person.role) return null;
  return `Has access · ${ROLE_LABEL[person.role]}${person.inherited ? ' via workbook' : ''}`;
}

export function ShareDialog({ boardId, workbookId, onClose }: { boardId?: string; workbookId?: string; onClose: () => void }) {
  const [state, setState] = useState<ShareState | null>(null);
  const [query, setQuery] = useState('');
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [people, setPeople] = useState<SharePerson[]>([]);
  const [searchStatus, setSearchStatus] = useState<'idle' | 'searching' | 'done' | 'limited' | 'failed'>('idle');
  const [searchedFor, setSearchedFor] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [role, setRole] = useState<ShareRole>('editor');
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState('');
  const [createdLink, setCreatedLink] = useState('');
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [transferTarget, setTransferTarget] = useState<Collaborator | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const transferRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const roleRef = useRef<HTMLSelectElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const listboxId = `${ids}-people`;
  const hintId = `${ids}-hint`;

  // Focus moves after React commits the change that makes its target exist.
  const pendingFocus = useRef<(() => HTMLElement | null | undefined) | null>(null);
  const focusAfterRender = (target: () => HTMLElement | null | undefined) => { pendingFocus.current = target; };
  useEffect(() => {
    const target = pendingFocus.current?.();
    if (target?.isConnected) { pendingFocus.current = null; target.focus(); }
  });
  const cancelConfirmation = () => {
    const trigger = confirming?.trigger;
    setConfirming(null);
    focusAfterRender(() => trigger);
  };
  // Escape closes the innermost thing first: suggestions, then an inline confirmation, then the dialog.
  useDialogFocus(dialogRef, !transferTarget, () => {
    if (listOpen) { setListOpen(false); return; }
    if (confirming) { cancelConfirmation(); return; }
    onClose();
  });
  useDialogFocus(transferRef, Boolean(transferTarget), () => setTransferTarget(null));
  const resourceKind = boardId ? 'board' : 'workbook';
  const resourceId = boardId ?? workbookId ?? '';
  const endpoint = `/api/v1/${resourceKind}s/${encodeURIComponent(resourceId)}`;
  const canShare = Boolean(state?.capabilities.share);

  const load = () => api(`${endpoint}/share`).then(value => setState(value as ShareState));
  const copyLink = async (link: string, id: string) => {
    setCopied('');
    try { await navigator.clipboard.writeText(link); setCopied(id); return true; }
    catch { setError('Could not copy the link. Select and copy it below.'); return false; }
  };

  useEffect(() => {
    void load().catch(value => setError(message(value, 'Could not load sharing')));
  }, [resourceId]);
  useEffect(() => { if (confirming) confirmRef.current?.focus(); }, [confirming]);
  // Owners land in "Add people" once sharing loads, unless they already moved focus.
  useEffect(() => {
    const focused = document.activeElement;
    if (canShare && (focused === closeRef.current || focused === dialogRef.current)) inputRef.current?.focus();
  }, [canShare]);

  const trimmed = query.trim();
  // Live search: debounced, and a newer keystroke cancels the request in flight.
  useEffect(() => {
    if (!canShare || recipient || !trimmed) { setPeople([]); setSearchStatus('idle'); return; }
    const controller = new AbortController();
    setSearchStatus('searching');
    const timer = window.setTimeout(() => {
      api(`${endpoint}/share/people?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then(value => { setPeople((value as { people: SharePerson[] }).people); setSearchedFor(trimmed); setSearchStatus('done'); })
        .catch(value => { if (!controller.signal.aborted) setSearchStatus(value instanceof RequestError && value.status === 429 ? 'limited' : 'failed'); });
    }, SEARCH_DELAY);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [trimmed, recipient, endpoint, canShare]);

  const results = searchedFor === trimmed ? people : [];
  const exactPerson = results.find(person => person.handle.toLowerCase() === trimmed.toLowerCase());
  const options: Recipient[] = [
    ...results.map(person => ({ kind: 'person' as const, person })),
    ...(EMAIL.test(trimmed) && !exactPerson ? [{ kind: 'email' as const, email: trimmed }] : []),
  ];
  const activeIndex = Math.min(active, options.length - 1);
  const showList = listOpen && Boolean(trimmed) && !recipient;
  // Typing a full address is enough: it resolves to the matching person, or to a link.
  const target: Recipient | null = recipient ?? (exactPerson ? { kind: 'person', person: exactPerson } : EMAIL.test(trimmed) ? { kind: 'email', email: trimmed } : null);
  const linkMode = target?.kind === 'email';

  const choose = (option: Recipient) => {
    setRecipient(option); setQuery(''); setListOpen(false); setActive(0); setNotice(''); setError('');
    focusAfterRender(() => roleRef.current);
  };
  const clearRecipient = () => {
    setRecipient(null);
    focusAfterRender(() => inputRef.current);
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!showList) { setListOpen(true); setActive(event.key === 'ArrowDown' ? 0 : Math.max(options.length - 1, 0)); return; }
      if (!options.length) return;
      setActive(index => {
        const current = Math.min(index, options.length - 1);
        return event.key === 'ArrowDown' ? (current + 1) % options.length : (current - 1 + options.length) % options.length;
      });
    } else if (event.key === 'Enter' && showList && options[activeIndex]) {
      event.preventDefault();
      choose(options[activeIndex]);
    } else if (event.key === 'Enter' && !target) {
      event.preventDefault();
    }
  };

  const showLink = async (token: string, id: string, email: string, replaced: boolean) => {
    const link = `${location.origin}/#invite=${encodeURIComponent(token)}`;
    setCreatedLink(link);
    const didCopy = await copyLink(link, id);
    setNotice(replaced
      ? `New link for ${email} ${didCopy ? 'copied' : 'created; copy it below'}. The old link no longer works.`
      : `Invite link for ${email} ${didCopy ? 'copied' : 'created; copy it below'}. Send it to them now: it’s shown only once.`);
  };

  const share = async (event: FormEvent) => {
    event.preventDefault();
    if (!target || busy) return;
    setBusy(true); setError(''); setNotice(''); setCopied('');
    try {
      const body = target.kind === 'person' ? { userId: target.person.id, role } : { email: target.email, role, expiresInDays: days };
      const result = await api(`${endpoint}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) as ShareResult;
      setRecipient(null); setQuery(''); setListOpen(false);
      if (result.granted) {
        const name = firstName(result.collaborator.name);
        const effective = result.collaborator.role;
        setCreatedLink('');
        setNotice(result.changed
          ? `${name} can now ${ROLE_VERB[role]}. We let them know.`
          : `${name} already ${effective === 'owner' ? 'owns this' : `has ${ROLE_LABEL[effective].toLowerCase()} access`}${result.collaborator.source === 'workbook' ? ' through the workbook' : ''}. Nothing changed.`);
      } else await showLink(result.token, result.id, result.email, false);
      try { await load(); }
      catch { setError('Shared, but the access list could not refresh. Reopen sharing to see it.'); }
      focusAfterRender(() => inputRef.current);
    } catch (value) { setError(message(value, 'Sharing failed')); }
    finally { setBusy(false); }
  };

  // Controls are disabled while a request runs, which drops focus; put it back afterwards.
  const keepFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && dialogRef.current?.contains(active)) focusAfterRender(() => active);
  };
  const mutate = async (work: () => Promise<unknown>, fallback: string) => {
    keepFocus();
    setBusy(true); setError(''); setNotice('');
    try { await work(); await load(); return true; }
    catch (value) { setError(message(value, fallback)); return false; }
    finally { setBusy(false); }
  };
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const changeRole = (userId: string, nextRole: string) => mutate(() => api(`${endpoint}/collaborators/${encodeURIComponent(userId)}`, json('PATCH', { role: nextRole })), 'Role update failed');
  const renew = (userId: string) => mutate(() => api(`${endpoint}/collaborators/${encodeURIComponent(userId)}`, json('PATCH', { expiresInDays: 30 })), 'Renewal failed');
  const setPrivate = (privateBoard: boolean) => mutate(() => api(`${endpoint}/catalog`, json('PATCH', { private: privateBoard })), 'Privacy update failed');

  const confirmAction = async () => {
    if (!confirming) return;
    const current = confirming;
    const done = current.kind === 'remove'
      ? await mutate(() => api(`${endpoint}/collaborators/${encodeURIComponent(current.person.id)}`, { method: 'DELETE' }), 'Removal failed')
      : await mutate(() => api(`${endpoint}/invitations/${encodeURIComponent(current.invitation.id)}`, { method: 'DELETE' }), 'Could not revoke the invitation');
    setConfirming(null);
    if (done) setNotice(current.kind === 'remove' ? `${current.person.name} no longer has access.` : `The invitation for ${current.invitation.email} was revoked.`);
    focusAfterRender(() => inputRef.current ?? closeRef.current);
  };

  // Tokens are stored hashed, so a lost link cannot be shown again. A new invitation
  // for the same address and role replaces it (the server revokes the old one).
  const reissue = async (invitation: PendingInvitation) => {
    keepFocus();
    setBusy(true); setError(''); setNotice(''); setCopied('');
    try {
      const result = await api(`${endpoint}/share`, json('POST', { invitationId: invitation.id, role: invitation.role, expiresInDays: 7 })) as ShareResult;
      if (result.granted) {
        setCreatedLink('');
        setNotice(`${result.collaborator.name} has joined the Studio, so they now have access directly. We let them know.`);
      } else {
        await showLink(result.token, result.id, result.email, true);
        focusAfterRender(() => linkRef.current);
      }
      await load();
    } catch (value) { setError(message(value, 'Could not create a new link')); }
    finally { setBusy(false); }
  };

  const transfer = async () => {
    if (!transferTarget) return;
    setBusy(true); setError('');
    try {
      await api(`${endpoint}/ownership`, json('POST', { userId: transferTarget.id }));
      onClose();
      location.reload();
    } catch (value) { setError(message(value, 'Ownership transfer failed')); }
    finally { setBusy(false); }
  };

  const openInvitations = state?.invitations.filter(item => item.status === 'pending' || item.status === 'expired') ?? [];
  const pastInvitations = state?.invitations.filter(item => item.status === 'accepted' || item.status === 'revoked') ?? [];
  const searchMessage = !trimmed || recipient ? ''
    : searchStatus === 'searching' && !results.length ? 'Searching…'
      : searchStatus === 'limited' ? 'Searching too quickly. Pause for a moment.'
        : searchStatus === 'failed' ? 'Search is unavailable. Enter an email address to invite by link.'
          : searchStatus === 'done' && !options.length ? (trimmed.includes('@') ? 'Finish the email address to invite them by link.' : `No Studio member matches “${trimmed}”. Enter their email to invite them by link.`)
            : '';
  const removalConsequence = resourceKind === 'board'
    ? 'They lose access to this board right away.'
    : 'They lose access to this workbook and its boards right away, except boards shared with them directly.';
  const hint = target?.kind === 'person'
    ? `${firstName(target.person.name)} gets access right away and a notification.${target.person.role ? ` They can already ${ROLE_ABILITY[target.person.role]}${target.person.inherited ? ' through the workbook' : ''}.` : ''}`
    : linkMode ? 'Creates a one-time invite link for you to send. Only this address can use it.'
      : 'Search your Studio by name or username, or enter an email address.';

  const confirmationRow = (id: string) => confirming && (confirming.kind === 'remove' ? confirming.person.id : confirming.invitation.id) === id ? (
    <div className="share-confirm" role="group" aria-labelledby={`${ids}-confirm`}>
      <p id={`${ids}-confirm`}>{confirming.kind === 'remove'
        ? <><strong>Remove {confirming.person.name}?</strong> {removalConsequence}</>
        : <><strong>Revoke the invitation for {confirming.invitation.email}?</strong> The link stops working right away.</>}</p>
      <div className="share-confirm-actions">
        <button ref={confirmRef} type="button" onClick={cancelConfirmation}>{confirming.kind === 'remove' ? 'Cancel' : 'Keep invitation'}</button>
        <button className="danger-button" type="button" disabled={busy} onClick={() => void confirmAction()}>{confirming.kind === 'remove' ? `Remove ${firstName(confirming.person.name)}` : 'Revoke link'}</button>
      </div>
    </div>
  ) : null;

  return (
    <div className="modal-backdrop share-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <header>
          <div><h2 id="share-title">Share this {resourceKind}</h2><p>Add people from your Studio, or invite someone by email.</p></div>
          <button ref={closeRef} type="button" aria-label="Close sharing" onClick={onClose}><UiIcon name="close" /></button>
        </header>
        {error ? <p className="dialog-error" role="alert">{error}</p> : null}

        {canShare ? (
          <form className="share-add" onSubmit={share} aria-labelledby={`${ids}-add`}>
            <label id={`${ids}-add`} htmlFor={`${ids}-input`} className="share-add-label">Add people</label>
            <div className="share-add-row">
              <div className={`share-field${recipient ? ' has-recipient' : ''}`}>
                {recipient ? (
                  <span className="share-chip">
                    {recipient.kind === 'person' ? <Avatar name={recipient.person.name} color={recipient.person.color} /> : <span className="person-avatar pending-avatar" aria-hidden="true"><UiIcon name="mail" /></span>}
                    <span className="share-chip-text">{recipient.kind === 'person' ? <>{recipient.person.name}<small>{recipient.person.handle}</small></> : recipient.email}</span>
                    <button type="button" aria-label={`Remove ${recipient.kind === 'person' ? recipient.person.name : recipient.email}`} onClick={clearRecipient}><UiIcon name="close" /></button>
                  </span>
                ) : (
                  <>
                    <UiIcon name="search" className="share-field-icon" />
                    <input
                      ref={inputRef}
                      id={`${ids}-input`}
                      type="text"
                      role="combobox"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={100}
                      aria-autocomplete="list"
                      aria-expanded={showList}
                      aria-controls={listboxId}
                      aria-activedescendant={showList && options[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
                      aria-describedby={hintId}
                      placeholder="Name, username or email"
                      value={query}
                      onChange={event => { setQuery(event.target.value); setListOpen(true); setActive(0); }}
                      onFocus={() => { if (trimmed) setListOpen(true); }}
                      onBlur={() => setListOpen(false)}
                      onKeyDown={onInputKey}
                    />
                  </>
                )}
                {showList ? (
                  <div className="share-suggestions">
                    <ul id={listboxId} role="listbox" aria-label="Suggestions">
                      {options.map((option, index) => (
                        <li
                          key={option.kind === 'person' ? option.person.id : `email:${option.email}`}
                          id={`${listboxId}-${index}`}
                          role="option"
                          aria-selected={index === activeIndex}
                          className={index === activeIndex ? 'active' : ''}
                          onMouseDown={event => { event.preventDefault(); choose(option); }}
                          onMouseMove={() => { if (index !== activeIndex) setActive(index); }}
                        >
                          {option.kind === 'person' ? <>
                            <Avatar name={option.person.name} color={option.person.color} />
                            <span className="share-option-text"><strong>{option.person.name}</strong><small>{option.person.handle}</small></span>
                            {accessLabel(option.person) ? <span className="share-option-access">{accessLabel(option.person)}</span> : null}
                          </> : <>
                            <span className="person-avatar pending-avatar" aria-hidden="true"><UiIcon name="mail" /></span>
                            <span className="share-option-text"><strong>Invite {option.email} by link</strong><small>No Studio account found. They join with a one-time link.</small></span>
                          </>}
                        </li>
                      ))}
                    </ul>
                    {searchMessage ? <p className="share-search-status">{searchMessage}</p> : null}
                  </div>
                ) : null}
              </div>
              <select ref={roleRef} className="share-role" value={role} aria-label="Role" onChange={event => setRole(event.target.value as ShareRole)}>
                <option value="editor">Editor</option><option value="commenter">Commenter</option><option value="viewer">Viewer</option>
              </select>
            </div>
            <p className="sr-only" aria-live="polite">{showList ? searchMessage || (searchStatus === 'done' ? `${options.length} suggestion${options.length === 1 ? '' : 's'}` : '') : ''}</p>
            <div className="share-add-footer">
              <p id={hintId} className="share-add-hint">{hint}</p>
              {linkMode ? <label className="share-expiry"><span>Link expires</span><select value={days} onChange={event => setDays(Number(event.target.value))}><option value={1}>in 1 day</option><option value={7}>in 7 days</option><option value={30}>in 30 days</option><option value={90}>in 90 days</option></select></label> : null}
              <button className="share-submit" type="submit" disabled={busy || !target}>{busy ? 'Working…' : linkMode ? 'Create invite link' : 'Share'}</button>
            </div>
          </form>
        ) : state ? <p className="share-note">You can see who has access. The {resourceKind} owner manages invitations and roles.</p> : null}
        <p className="share-status" role="status">{notice ? <><UiIcon name="check" />{notice}</> : null}</p>
        {createdLink ? <label className="share-copy-fallback"><span>{createdLink.includes('#invite=') ? 'Invite link (shown once)' : 'Board link'}</span><input ref={linkRef} readOnly value={createdLink} onFocus={event => event.target.select()} /></label> : null}

        <section className="share-list" aria-labelledby="access-heading">
          <h3 id="access-heading">People with access</h3>
          {state?.collaborators.map(person => {
            const manageable = state.capabilities.share && person.role !== 'owner' && person.source !== 'workbook';
            return (
              <div className="share-person-group" key={person.id}>
                <div className="share-person">
                  <Avatar name={person.name} color={person.color} />
                  <div><strong>{person.name}</strong><small>{[person.email, person.source === 'workbook' ? 'via workbook' : '', person.expiresAt ? `expires ${new Date(person.expiresAt).toLocaleDateString()}` : ''].filter(Boolean).join(' · ')}</small></div>
                  {manageable ? <div className="share-person-controls">
                    <select aria-label={`Role for ${person.name}`} disabled={busy} value={person.role} onChange={event => void changeRole(person.id, event.target.value)}><option value="editor">Editor</option><option value="commenter">Commenter</option><option value="viewer">Viewer</option></select>
                    <div className="person-actions">
                    {person.expiresAt ? <button type="button" disabled={busy} onClick={() => void renew(person.id)}>Renew</button> : null}
                    <button type="button" disabled={busy} onClick={() => setTransferTarget(person)}>Transfer ownership</button>
                    <button className="icon-danger" disabled={busy} type="button" aria-label={`Remove ${person.name}`} aria-expanded={confirming?.kind === 'remove' && confirming.person.id === person.id} onClick={event => setConfirming({ kind: 'remove', person, trigger: event.currentTarget })}><UiIcon name="close" /></button>
                    </div>
                  </div> : <span className="role-pill">{ROLE_LABEL[person.role]}</span>}
                </div>
                {confirmationRow(person.id)}
              </div>
            );
          })}
          {!state ? <p>Loading access…</p> : null}
        </section>

        {canShare && (openInvitations.length || pastInvitations.length) ? (
          <section className="share-list" aria-labelledby="pending-heading">
            <h3 id="pending-heading">Invite links</h3>
            <p className="share-list-hint">Links are shown once for security. A new link replaces the old one.</p>
            {openInvitations.map(invitation => (
              <div className="share-person-group" key={invitation.id}>
                <div className="share-person">
                  <span className="person-avatar pending-avatar" aria-hidden="true"><UiIcon name="mail" /></span>
                  <div><strong>{invitation.email}</strong><small>{invitation.status === 'expired' ? 'Expired' : 'Not accepted yet'} · {ROLE_LABEL[invitation.role]} · {invitation.status === 'expired' ? 'ended' : 'expires'} {new Date(invitation.expiresAt).toLocaleDateString()}</small></div>
                  <div className="share-person-controls">
                    {copied === invitation.id ? <span className="copied-label">Link copied</span> : null}
                    <div className="person-actions">
                      <button type="button" disabled={busy} onClick={() => void reissue(invitation)} aria-label={`New link for ${invitation.email}`}>New link</button>
                      {invitation.status === 'pending' ? <button type="button" disabled={busy} aria-expanded={confirming?.kind === 'revoke' && confirming.invitation.id === invitation.id} onClick={event => setConfirming({ kind: 'revoke', invitation, trigger: event.currentTarget })} aria-label={`Revoke invitation for ${invitation.email}`}>Revoke</button> : null}
                    </div>
                  </div>
                </div>
                {confirmationRow(invitation.id)}
              </div>
            ))}
            {pastInvitations.length ? (
              <details className="share-history">
                <summary>Past invitations ({pastInvitations.length})</summary>
                {pastInvitations.map(invitation => (
                  <div className="share-person" key={invitation.id}>
                    <span className="person-avatar pending-avatar" aria-hidden="true"><UiIcon name="mail" /></span>
                    <div><strong>{invitation.email}</strong><small>{invitation.status === 'accepted' ? 'Accepted' : 'Revoked'} · {ROLE_LABEL[invitation.role]}</small></div>
                  </div>
                ))}
              </details>
            ) : null}
          </section>
        ) : null}

        {boardId ? <section className="share-board-link" aria-label="Board link and privacy">
          <div className="share-actions">
            <button type="button" onClick={() => { setCreatedLink(location.href); void copyLink(location.href, 'board-link'); }}>{copied === 'board-link' ? <><UiIcon name="check" />Board link copied</> : <><UiIcon name="share" />Copy board link</>}</button>
            {canShare ? <label className="privacy-toggle"><input type="checkbox" checked={Boolean(state?.private)} disabled={busy} onChange={event => void setPrivate(event.target.checked)} /><span>Private board</span></label> : null}
          </div>
          <p className="share-link-hint">Copying a board link does not grant access.</p>
          {state?.private ? <p className="share-note">Workbook access is off. Add people directly or enable a guest link below.</p> : <p className="share-note">Workbook access is inherited. People marked “via workbook” are managed from the workbook.</p>}
        </section> : <p className="share-note">Workbook access applies to every board in it, except boards marked private.</p>}
        {boardId && canShare ? <GuestSharing boardId={boardId} /> : null}

        {transferTarget ? <div ref={transferRef} tabIndex={-1} className="transfer-confirm" role="alertdialog" aria-modal="true" aria-labelledby="transfer-title"><h3 id="transfer-title">Transfer ownership to {transferTarget.name}?</h3><p>You will become an editor. The new owner can change access and delete the {resourceKind}.</p><div className="button-row"><button type="button" onClick={() => setTransferTarget(null)}>Cancel</button><button className="danger-button" disabled={busy} type="button" onClick={() => void transfer()}>Transfer ownership</button></div></div> : null}
      </section>
    </div>
  );
}
