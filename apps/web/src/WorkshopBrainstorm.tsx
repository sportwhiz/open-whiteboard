import { reportWriting } from "./brainstorm-writing";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { apiFetch } from './auth-client';
import { formatTimer } from './board-timer';
import { useBoardDraft } from './collaboration-drafts';
import { sendCollaborationCommand, type CommandResult, type CommandValues } from './collaboration-commands';
import { quote } from './collaboration-labels';
import { STICKY_PALETTE } from './blocksuite/sticky-palette';
import { visibleCanvasCentre } from './panel-focus';
import type { PublicCollaborationState } from './room-collaboration';
import { useCountdown } from './useCountdown';

type DraftColor = 'yellow' | 'orange' | 'green' | 'blue' | 'purple';
type Area = { x: number; y: number; width: number; height: number };
// Brainstorm drafts use the note toolbar's papers, names and order. Pink is
// left out until every supported deployment can read it in stored drafts.
const DRAFT_FAMILIES: readonly DraftColor[] = ['yellow', 'orange', 'purple', 'blue', 'green'];
const DRAFT_COLORS: { value: DraftColor; label: string; paper: string }[] = STICKY_PALETTE
  .filter((family): family is typeof family & { id: DraftColor } => (DRAFT_FAMILIES as readonly string[]).includes(family.id))
  .map(family => ({ value: family.id, label: family.name, paper: family.light }));
const TIME_LIMITS = [0, 3, 5, 10];
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The countdown for a brainstorm's optional time limit. */
function useDeadline(endsAt: string | null | undefined) {
  const seconds = useCountdown(endsAt ? { status: 'running', label: '', startedBy: '', startedAt: '', endsAt, remainingMs: 0 } : null);
  return endsAt ? seconds : null;
}

export function WorkshopBrainstorm({ boardId, state, command, announce, leads, takeOver, showArea }: {
  boardId: string;
  state: PublicCollaborationState;
  command: (action: string, values?: CommandValues) => Promise<CommandResult | null>;
  announce: (text: string) => void;
  /** Whether this person runs the session (sees facilitator controls). */
  leads: boolean;
  takeOver: ReactNode;
  showArea: (area: Area, objectId?: string | null) => void;
}) {
  const brainstorm = state.brainstorm;
  const active = Boolean(brainstorm && ['running', 'closed'].includes(brainstorm.status));
  const running = brainstorm?.status === 'running';
  const [draft, setDraft] = useBoardDraft(boardId, 'brainstorm-draft', '');
  const [draftColor, setDraftColor] = useState<DraftColor>('yellow');
  const [title, setTitle] = useState('Silent brainstorm');
  const [instructions, setInstructions] = useState('Write one idea per sticky note.');
  const [minutes, setMinutes] = useState(0);
  const [confirm, setConfirm] = useState<'reveal' | 'cancel' | null>(null);
  const [leftoverBusy, setLeftoverBusy] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  // Focus the confirmation's main action once, when it opens; re-renders
  // (someone starts typing elsewhere) must not pull focus back to it.
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirm) confirmRef.current?.focus({ preventScroll: true }); }, [confirm]);
  const returnTo = useRef<string | null>(null);
  const secondsLeft = useDeadline(running ? brainstorm?.endsAt : null);
  const hasText = draft.trim().length > 0;

  // Refresh while a draft is open so long sessions and temporary network
  // failures cannot make an active writer disappear from the reveal warning.
  useEffect(() => {
    if (!active) return;
    return reportWriting(writing => sendCollaborationCommand(boardId, 'brainstorm_writing', { writing }), hasText);
  }, [active, hasText, brainstorm?.id, boardId]);

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!hasText || !running) return;
    if (!await command('save_draft', { text: draft, color: draftColor })) return;
    setDraft('');
    announce('Idea saved privately. Submit it when you want it revealed.');
    draftRef.current?.focus({ preventScroll: true });
  };
  const onKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
  };
  const remove = async (draftId: string) => {
    const drafts = brainstorm?.myDrafts ?? [];
    const index = drafts.findIndex(item => item.id === draftId);
    const neighbor = drafts[index + 1] ?? drafts[index - 1];
    if (!await command('delete_draft', { draftId })) return;
    announce('Idea deleted.');
    requestAnimationFrame(() => {
      const next = neighbor ? document.querySelector<HTMLElement>(`[data-focus-group="${CSS.escape(neighbor.id)}"] button`) : null;
      (next ?? draftRef.current)?.focus({ preventScroll: true });
    });
  };
  const unsubmitted = brainstorm?.myDrafts.filter(item => !item.submittedAt) ?? [];
  const submitAll = async () => {
    const results = await Promise.all(unsubmitted.map(item => command('submit_draft', { draftId: item.id })));
    const done = results.filter(Boolean).length;
    const failed = results.length - done;
    announce(failed ? `Submitted ${done} of ${plural(results.length, 'idea')}. ${failed} could not be submitted; try again.` : `Submitted ${plural(done, 'idea')}.`);
  };
  const reveal = async () => {
    setConfirm(null);
    const view = visibleCanvasCentre(state.participants.find(person => person.id === state.currentUserId && person.viewport)?.viewport);
    const count = brainstorm?.submittedCount ?? 0;
    const result = await command('reveal_brainstorm', view ? { nearX: view.x, nearY: view.y } : {});
    if (!result) return;
    announce(`Revealed ${plural(count, 'idea')} in a new frame. Showing them on the board.`);
    if (result.revealedArea) showArea(result.revealedArea);
  };
  // After a reveal or cancel, text someone was still writing stays here, and
  // can still go on the board.
  const addLeftover = async () => {
    setLeftoverBusy(true);
    try {
      const view = visibleCanvasCentre(state.participants.find(person => person.id === state.currentUserId && person.viewport)?.viewport);
      const response = await apiFetch(`/api/v1/boards/${encodeURIComponent(boardId)}/commands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: crypto.randomUUID(), operations: [{ type: 'create_note', text: draft.trim().slice(0, 20_000), color: draftColor, x: Math.round((view?.x ?? 0) - 104), y: Math.round((view?.y ?? 0) - 104) }] }),
      });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not add the idea to the board.');
      setDraft('');
      announce('Your idea was added to the board.');
    } catch (failure) { announce(failure instanceof Error ? failure.message : 'Could not add the idea to the board.'); }
    finally { setLeftoverBusy(false); }
  };

  const writing = brainstorm?.writingCount ?? 0;
  const waiting = brainstorm?.unsubmittedCount ?? 0;
  const facilitatorStatus = [writing ? `${plural(writing, 'person', 'people')} still writing` : '', waiting ? `${plural(waiting, 'idea')} not submitted` : ''].filter(Boolean).join(' · ');

  // One list of keyed children: the composer keeps its identity (and focus)
  // whatever happens around it, including a reveal while someone is typing.
  const children: ReactNode[] = [<h3 key="title">Private brainstorming</h3>];
  if (active && brainstorm) {
    children.push(<div key="brief" className="brainstorm-brief">
      <strong>{brainstorm.title}</strong>
      {brainstorm.instructions ? <p>{brainstorm.instructions}</p> : null}
      <small>
        {running ? 'Collecting ideas' : 'Collection closed'} · {plural(brainstorm.submittedCount, 'idea')} submitted
        {brainstorm.participantCount ? ` · ${plural(brainstorm.participantCount, 'person', 'people')} taking part` : ''}
      </small>
      {secondsLeft !== null ? <span className={`brainstorm-deadline ${secondsLeft === 0 ? 'over' : ''}`} role="timer" aria-live="off">
        {secondsLeft > 0 ? `${formatTimer(secondsLeft)} left` : 'Time is up. Ideas are still collected until the facilitator reveals.'}
      </span> : null}
    </div>);
  } else if (brainstorm?.status === 'revealed') {
    children.push(<div key="revealed" className="brainstorm-revealed"><strong tabIndex={-1} data-landing>Ideas revealed</strong><p>They are in the “{brainstorm.title}” frame on the board.</p>{brainstorm.revealedArea ? <button type="button" onClick={() => showArea(brainstorm.revealedArea!, brainstorm.revealedIds[0] ?? null)}>Show revealed ideas</button> : null}</div>);
  }
  const canContribute = state.capabilities.comment;
  if (active && !canContribute) {
    children.push(<p key="viewer" className="participation-note">You are viewing this board, so you can follow along, react and raise a hand. Ask the board owner for comment access to add ideas.</p>);
  }
  if (canContribute && (running || hasText)) {
    const closedNote = !running && hasText ? (active
      ? 'Collection is closed, so this cannot be added yet. Your text stays here if the facilitator reopens collection.'
      : 'This was not included. It is still here, only for you.') : null;
    children.push(<form key="composer" className="comment-composer brainstorm-composer" onSubmit={event => void save(event)}>
      <textarea ref={draftRef} data-landing data-draft value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKey} aria-label="Your idea" aria-describedby={closedNote ? 'brainstorm-composer-note' : undefined} placeholder="Only you can see this idea until it is revealed" />
      {closedNote ? <p className="panel-hint" id="brainstorm-composer-note">{closedNote}</p> : null}
      <div className="brainstorm-composer-row">
        <div className="draft-colors" role="radiogroup" aria-label="Sticky color">{DRAFT_COLORS.map(color => <label key={color.value} className={`draft-swatch draft-${color.value}`} style={{ background: color.paper }} title={color.label}><input type="radio" name="draft-color" value={color.value} checked={draftColor === color.value} onChange={() => setDraftColor(color.value)} /><span className="sr-only">{color.label}</span></label>)}</div>
        {running ? <button type="submit" disabled={!hasText} title="Add idea (⌘ or Ctrl + Enter)">Add idea</button>
          : !active ? <span className="leftover-actions">{state.capabilities.edit ? <button type="button" disabled={leftoverBusy} onClick={() => void addLeftover()}>Add to board</button> : <button type="button" onClick={() => void navigator.clipboard?.writeText(draft).then(() => announce('Copied.'))}>Copy text</button>}<button type="button" onClick={() => setDraft('')}>Discard</button></span>
          : <button type="submit" aria-disabled="true" onClick={event => event.preventDefault()}>Add idea</button>}
      </div>
    </form>);
  }
  if (active && brainstorm) {
    if (!canContribute) { /* Viewers have no private ideas. */ }
    else if (brainstorm.myDrafts.length) {
      children.push(<div key="drafts" className="draft-list" aria-label="Your ideas">
        <div className="draft-list-heading"><span>Your ideas · {brainstorm.myDrafts.filter(item => item.submittedAt).length} of {brainstorm.myDrafts.length} submitted</span>{unsubmitted.length > 1 ? <button type="button" className="text-action" onClick={() => void submitAll()}>Submit all ({unsubmitted.length})</button> : null}</div>
        {!running && unsubmitted.length ? <p className="panel-hint">Collection is closed. You can still submit saved ideas until they are revealed.</p> : null}
        {brainstorm.myDrafts.map(item => <article key={item.id} data-focus-group={item.id} className={`draft-${item.color}`}>
          <p>{item.text}</p>
          <div className="draft-actions"><span className={`draft-state ${item.submittedAt ? 'submitted' : ''}`}>{item.submittedAt ? 'Submitted' : 'Private draft'}</span>
            <button type="button" onClick={() => void command(item.submittedAt ? 'withdraw_draft' : 'submit_draft', { draftId: item.id })}>{item.submittedAt ? 'Withdraw' : 'Submit'}</button>
            <button type="button" aria-label={`Delete idea ${quote(item.text, 30)}`} onClick={() => void remove(item.id)}>Delete</button>
          </div>
        </article>)}
      </div>);
    } else if (running) children.push(<p key="hint" className="panel-hint">Add ideas, then submit the ones you want revealed.</p>);
    if (leads) {
      children.push(<div key="facilitator" className="facilitator-box" data-focus-scope="brainstorm-facilitator">
        <strong>Facilitator</strong>
        {facilitatorStatus && confirm !== 'reveal' ? <p className="facilitator-status">{facilitatorStatus}</p> : null}
        {confirm === 'reveal' ? <div className="confirm-inline" role="group" aria-label="Reveal ideas">
          <span>{facilitatorStatus ? <strong>{facilitatorStatus}. </strong> : null}Reveal {plural(brainstorm.submittedCount, 'submitted idea')} now? Anything not submitted stays private.</span>
          <button type="button" className="primary-panel-action" ref={confirmRef} onClick={() => void reveal()}>Reveal now</button>
          <button type="button" onClick={() => { returnTo.current = 'reveal'; setConfirm(null); }}>Wait</button>
        </div> : <div className="button-row">
          <button type="button" className="primary-panel-action" aria-disabled={!brainstorm.submittedCount} data-landing ref={element => { if (element && returnTo.current === 'reveal') { returnTo.current = null; element.focus({ preventScroll: true }); } }}
            title={brainstorm.submittedCount ? undefined : 'Nothing has been submitted yet'}
            onClick={() => { if (!brainstorm.submittedCount) return; if (writing || waiting) setConfirm('reveal'); else void reveal(); }}>
            Reveal {plural(brainstorm.submittedCount, 'idea')}
          </button>
          {running ? <button type="button" onClick={() => void command('close_brainstorm')}>Close collection</button> : <button type="button" onClick={() => void command('reopen_brainstorm')}>Reopen collection</button>}
        </div>}
        <small>{brainstorm.submittedCount ? 'Ideas appear together in a new frame, in open space near your view.' : 'Reveal becomes available when someone submits an idea.'}</small>
        {confirm === 'cancel' ? <span className="confirm-inline" role="group" aria-label="Cancel brainstorm"><span>Discard everyone’s ideas, submitted or private?</span><button type="button" className="danger-text" ref={confirmRef} onClick={() => void command('cancel_brainstorm').then(() => setConfirm(null))}>Discard ideas</button><button type="button" onClick={() => { returnTo.current = 'cancel'; setConfirm(null); }}>Keep brainstorm</button></span>
          : <button type="button" className="text-action danger-text" ref={element => { if (element && returnTo.current === 'cancel') { returnTo.current = null; element.focus({ preventScroll: true }); } }} onClick={() => setConfirm('cancel')}>Cancel brainstorm…</button>}
      </div>);
    } else children.push(<div key="take-over">{takeOver}</div>);
  } else if (leads) {
    children.push(<form key="setup" className="workshop-settings" onSubmit={event => { event.preventDefault(); void command('start_brainstorm', { title, instructions, durationSeconds: minutes * 60 }); }}>
      <label><span>Title</span><input value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label><span>Instructions</span><textarea value={instructions} onChange={event => setInstructions(event.target.value)} /></label>
      <fieldset className="time-limit"><legend>Time limit</legend><div className="timer-presets" role="group" aria-label="Time limit">{TIME_LIMITS.map(value => <button type="button" key={value} aria-pressed={minutes === value} onClick={() => setMinutes(value)}>{value ? `${value} min` : 'None'}</button>)}</div>
        <small>{minutes ? 'Everyone sees the countdown. When it ends, ideas are still collected until you reveal.' : 'Collection stays open until you reveal.'}</small></fieldset>
      <button type="submit">{brainstorm?.status === 'revealed' ? 'Start another brainstorm' : 'Start private brainstorm'}</button>
    </form>);
  } else if (brainstorm?.status !== 'revealed') {
    children.push(<p key="idle" className="panel-hint" tabIndex={-1} data-landing>No private brainstorm is running. The facilitator will start one.</p>);
    children.push(<div key="take-over">{takeOver}</div>);
  }
  return <section className="facilitation-detail brainstorm-detail" data-focus-scope="brainstorm">{children}</section>;
}

