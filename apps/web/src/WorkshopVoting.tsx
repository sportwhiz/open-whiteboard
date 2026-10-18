import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { voteValues, type CommandResult, type CommandValues } from './collaboration-commands';
import type { SemanticBoard } from './collaboration-labels';
import { defaultVoteTargets, MAX_VOTE_TARGETS, type VoteSource } from './facilitation';
import { queryCanvas } from './panel-focus';
import type { PublicCollaborationState } from './room-collaboration';

type Note = { id: string; text?: string; xywh?: string; frameIds?: string[] };
const PAGE = 50;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Pan the canvas to a sticky that was voted on. */
function locate(note: Note | undefined, id: string) {
  let x = 0, y = 0;
  try { const [left, top, width, height] = JSON.parse(note?.xywh ?? '') as number[]; x = left + width / 2; y = top + height / 2; } catch { /* objectId is enough */ }
  window.dispatchEvent(new CustomEvent('whiteboard-focus-anchor', { detail: { x, y, objectId: id } }));
}

export function WorkshopVoting({ state, semantic, command, leads, takeOver, peopleCount }: {
  state: PublicCollaborationState;
  semantic: SemanticBoard & { notes: Note[] };
  command: (action: string, values?: CommandValues) => Promise<CommandResult | null>;
  leads: boolean;
  takeOver: ReactNode;
  peopleCount: number;
}) {
  const runningVote = state.voteRounds.find(round => round.status === 'running');
  const latestVote = state.voteRounds[0];
  const notes = semantic.notes as Note[];
  const noteIds = useMemo(() => notes.map(note => note.id), [notes]);
  const revealedIds = state.brainstorm?.status === 'revealed' ? state.brainstorm.revealedIds : [];
  const [targets, setTargets] = useState<string[]>([]);
  const [source, setSource] = useState<VoteSource | 'frame' | 'custom'>('all');
  const touched = useRef(false);
  const [query, setQuery] = useState('');
  const [frame, setFrame] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [limit, setLimit] = useState(3);
  const [cap, setCap] = useState(1);
  const limitTouched = useRef(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const confirmEndRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmEnd) confirmEndRef.current?.focus({ preventScroll: true }); }, [confirmEnd]);
  const [minutes, setMinutes] = useState(5);
  const [anonymous, setAnonymous] = useState(true);
  // What is selected on the canvas, asked when the setup opens and after
  // pointer or keyboard selection changes (not on every render).
  const [selection, setSelection] = useState<string[]>(() => queryCanvas().selection ?? []);
  useEffect(() => {
    if (runningVote) return;
    const refresh = () => setSelection(current => { const next = queryCanvas().selection ?? []; return next.join('|') === current.join('|') ? current : next; });
    window.addEventListener('pointerup', refresh);
    window.addEventListener('keyup', refresh);
    return () => { window.removeEventListener('pointerup', refresh); window.removeEventListener('keyup', refresh); };
  }, [Boolean(runningVote)]);
  const selectedNotes = selection.filter(id => noteIds.includes(id));

  // Until someone edits the choice, follow the best default: just-revealed
  // ideas, otherwise the canvas selection, otherwise every sticky.
  useEffect(() => {
    if (touched.current || runningVote) return;
    const choice = defaultVoteTargets(noteIds, { revealedIds, selection });
    setTargets(choice.targets);
    setSource(choice.source);
  }, [noteIds.join('|'), revealedIds.join('|'), selection.join('|'), Boolean(runningVote)]);

  // Sensible defaults for the number of ideas: one idea gets one vote each.
  useEffect(() => {
    if (limitTouched.current) return;
    const next = Math.max(1, Math.min(3, targets.length));
    setLimit(next);
    setCap(value => Math.min(value, next));
  }, [targets.length]);
  const choose = (next: string[], from: typeof source) => { touched.current = true; setTargets(next.slice(0, MAX_VOTE_TARGETS)); setSource(from); };
  const filtered = notes.filter(note => (!query.trim() || (note.text ?? '').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && (!frame || note.frameIds?.includes(frame)));
  // Computed from the freshest ballot when the queued command runs.
  const castVote = (change: (votes: string[]) => string[]) => command('cast_vote', voteValues(change));
  const label = (id: string) => notes.find(note => note.id === id)?.text?.trim() || 'Untitled idea';

  const children: ReactNode[] = [<h3 key="title">Voting</h3>];
  if (runningVote) {
    const left = Math.max(0, runningVote.votesPerUser - runningVote.myVotes.length);
    children.push(<div key="status" className="vote-status"><strong>{runningVote.title}</strong>
      <span>{left} of {runningVote.votesPerUser} votes left{runningVote.maxPerTarget > 1 ? ` · up to ${runningVote.maxPerTarget} per idea` : ' · one per idea'}</span>
      <span className="vote-progress" aria-live="polite"><i style={{ width: `${Math.min(100, (runningVote.votedCount / Math.max(1, peopleCount)) * 100)}%` }} aria-hidden="true" />{runningVote.votedCount} of {plural(peopleCount, 'person', 'people')} voted</span>
    </div>);
    if (!state.capabilities.comment) {
      children.push(<p key="viewer" className="participation-note">You are viewing this board, so you can see what is being voted on, react and raise a hand. Ask the board owner for comment access to vote.</p>);
      children.push(<ul key="targets" className="vote-targets view-only">{runningVote.targets.map(target => <li key={target}>{label(target)}</li>)}</ul>);
      if (!leads) children.push(<div key="take-over">{takeOver}</div>);
      return <section className="facilitation-detail voting-detail" data-focus-scope="voting">{children}</section>;
    }
    children.push(<div key="targets" className="vote-targets">{runningVote.targets.map(target => {
      const count = runningVote.myVotes.filter(item => item === target).length;
      return <div className={`vote-choice ${count ? 'voted' : ''}`} key={target} data-focus-group={`vote:${target}`}>
        <span>{label(target)}</span>
        <button type="button" aria-label={`Remove vote from ${label(target)}`} disabled={count === 0} onClick={() => void castVote(votes => { const next = [...votes]; const index = next.indexOf(target); if (index >= 0) next.splice(index, 1); return next; })}><span aria-hidden="true">−</span></button>
        <b aria-label={plural(count, 'vote')}>{count}</b>
        <button type="button" aria-label={`Vote for ${label(target)}`} disabled={runningVote.myVotes.length >= runningVote.votesPerUser || count >= runningVote.maxPerTarget} onClick={() => void castVote(votes => votes.length < runningVote.votesPerUser && votes.filter(item => item === target).length < runningVote.maxPerTarget ? [...votes, target] : votes)}><span aria-hidden="true">+</span></button>
      </div>;
    })}</div>);
    const waiting = Math.max(0, peopleCount - runningVote.votedCount);
    const endVote = () => { setConfirmEnd(false); void command('end_vote', { roundId: runningVote.id }); };
    children.push(<div key="actions" className="button-row"><button type="button" disabled={!runningVote.myVotes.length} onClick={() => void castVote(() => [])}>Clear my votes</button>{leads && !confirmEnd ? <button type="button" className="primary-panel-action" onClick={() => { if (waiting) setConfirmEnd(true); else endVote(); }}>End vote and show results</button> : null}</div>);
    if (leads && confirmEnd) children.push(<div key="confirm-end" className="confirm-inline" role="group" aria-label="End vote">
      <span>{plural(waiting, 'person', 'people')} {waiting === 1 ? 'hasn’t' : 'haven’t'} voted yet. End the vote now?</span>
      <button type="button" className="primary-panel-action" ref={confirmEndRef} onClick={endVote}>End vote</button>
      <button type="button" onClick={() => setConfirmEnd(false)}>Keep voting</button>
    </div>);
    if (!leads) children.push(<div key="take-over">{takeOver}</div>);
    return <section className="facilitation-detail voting-detail" data-focus-scope="voting">{children}</section>;
  }
  if (latestVote?.status === 'ended') {
    const max = Math.max(1, ...Object.values(latestVote.results ?? {}));
    children.push(<div key="results" className="vote-history"><h4 tabIndex={-1} data-landing>Results · {latestVote.title}</h4>
      <p className="panel-hint">Select a result to find the sticky on the board.</p>
      {[...latestVote.targets].sort((a, b) => (latestVote.results?.[b] ?? 0) - (latestVote.results?.[a] ?? 0)).map((target, index) => {
        const total = latestVote.results?.[target] ?? 0;
        return <button type="button" className="vote-result" key={target} onClick={() => locate(notes.find(note => note.id === target), target)} aria-label={`${label(target)}: ${plural(total, 'vote')}. Show on board`}>
          <span className="vote-rank" aria-hidden="true">{index + 1}</span>
          <span>{label(target)}{latestVote.voterNames?.[target]?.length ? <small>{latestVote.voterNames[target].join(', ')}</small> : null}</span>
          <b className="vote-badge">{total}</b><i aria-hidden="true" style={{ width: `${(total / max) * 100}%` }} />
        </button>;
      })}</div>);
  }
  if (leads && notes.length) {
    // Chosen ideas first, so the current choice is always visible.
    const visible = [...filtered].sort((a, b) => Number(targets.includes(b.id)) - Number(targets.includes(a.id))).slice(0, shown);
    // "Select none" whenever any shown idea is chosen; a vote holds at most
    // 100, so "everything selected" may never be reachable.
    const anyShownSelected = filtered.some(note => targets.includes(note.id));
    children.push(<form key="setup" className="workshop-settings vote-setup" onSubmit={event => { event.preventDefault(); void command('start_vote', { title: 'Vote on ideas', targets, votesPerUser: limit, maxPerTarget: cap, anonymous, durationSeconds: minutes * 60 }); }}>
      <fieldset className="vote-sources"><legend>Vote on</legend>
        <div className="timer-presets" role="group" aria-label="Choose ideas">
          {revealedIds.length ? <button type="button" aria-pressed={source === 'revealed'} onClick={() => choose(defaultVoteTargets(noteIds, { revealedIds }).targets, 'revealed')}>Revealed ideas</button> : null}
          {selectedNotes.length ? <button type="button" aria-pressed={source === 'selection'} onClick={() => choose(selectedNotes, 'selection')}>Selection ({selectedNotes.length})</button> : null}
          <button type="button" aria-pressed={source === 'all'} onClick={() => choose(noteIds, 'all')}>All stickies</button>
        </div>
        {semantic.frames.length ? <label className="vote-frame"><span>In frame</span><select value={frame} onChange={event => { setFrame(event.target.value); setShown(PAGE); if (event.target.value) choose(notes.filter(note => note.frameIds?.includes(event.target.value)).map(note => note.id), 'frame'); }}><option value="">Any frame</option>{semantic.frames.map(item => <option key={item.id} value={item.id}>{item.title || 'Untitled frame'}</option>)}</select></label> : null}
      </fieldset>
      <div className="eligible-notes">
        <div className="eligible-toolbar">
          <input type="search" aria-label="Filter ideas" placeholder={`Filter ${plural(notes.length, 'sticky', 'stickies')}`} value={query} onChange={event => { setQuery(event.target.value); setShown(PAGE); }} />
          <button type="button" className="text-action" onClick={() => choose(anyShownSelected ? targets.filter(id => !filtered.some(note => note.id === id)) : [...new Set([...targets, ...filtered.map(note => note.id)])], 'custom')}>{anyShownSelected ? 'Select none' : filtered.length > MAX_VOTE_TARGETS ? `Select first ${MAX_VOTE_TARGETS}` : 'Select all'}</button>
        </div>
        <p className="eligible-count" aria-live="polite">{targets.length} selected{targets.length >= MAX_VOTE_TARGETS ? ` · a vote holds up to ${MAX_VOTE_TARGETS}` : ''}</p>
        <div className="eligible-list" role="group" aria-label="Ideas to vote on">
          {visible.map(note => <label key={note.id}><input type="checkbox" checked={targets.includes(note.id)} disabled={!targets.includes(note.id) && targets.length >= MAX_VOTE_TARGETS} onChange={event => choose(event.target.checked ? [...targets, note.id] : targets.filter(id => id !== note.id), 'custom')} /><span>{note.text?.trim() || 'Untitled idea'}</span></label>)}
          {!filtered.length ? <p className="panel-hint">No stickies match.</p> : null}
        </div>
        {filtered.length > shown ? <button type="button" className="text-action" onClick={() => setShown(value => value + PAGE)}>Show {Math.min(PAGE, filtered.length - shown)} more of {filtered.length - shown}</button> : null}
      </div>
      <div className="workshop-grid"><label><span>Votes each</span><input type="number" min={1} max={20} value={limit} onChange={event => { limitTouched.current = true; setLimit(Number(event.target.value)); if (cap > Number(event.target.value)) setCap(Math.max(1, Number(event.target.value))); }} /></label><label><span>Max per idea</span><input type="number" min={1} max={Math.max(1, limit)} value={cap} onChange={event => setCap(Math.min(Math.max(1, limit), Number(event.target.value)))} /></label><label><span>Minutes</span><input type="number" min={0} max={60} value={minutes} onChange={event => setMinutes(Number(event.target.value))} /></label></div>
      <label className="privacy-toggle"><input type="checkbox" checked={anonymous} onChange={event => setAnonymous(event.target.checked)} /><span>Anonymous results</span></label>
      <button type="submit" disabled={!targets.length}>Start vote on {plural(targets.length, 'idea')}</button>
    </form>);
  } else if (latestVote?.status !== 'ended') {
    children.push(<p key="idle" className="panel-hint" tabIndex={-1} data-landing>{leads ? 'Add sticky notes before starting a vote.' : 'No vote is open right now.'}</p>);
  }
  if (!leads) children.push(<div key="take-over">{takeOver}</div>);
  return <section className="facilitation-detail voting-detail" data-focus-scope="voting">{children}</section>;
}
