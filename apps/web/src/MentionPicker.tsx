import { useId, useMemo, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { avatarInk } from './avatar-color';

export type MentionPerson = { id: string; name: string; username?: string | null; color: string };

/** The "@query" being typed just before the caret, if any. */
export function mentionQuery(text: string, caret: number) {
  const before = text.slice(0, caret);
  const match = /(?:^|[\s(])@([^\s@]{0,30}(?: [^\s@]{0,30})?)$/u.exec(before);
  return match ? { query: match[1], start: caret - match[1].length - 1 } : null;
}

/** People matching a query, best first: name or username starting with it, then containing it. */
export function mentionMatches(people: MentionPerson[], query: string, limit = 6) {
  const term = query.trim().toLocaleLowerCase();
  const score = (person: MentionPerson) => {
    const values = [person.name, person.username ?? ''].map(value => value.toLocaleLowerCase());
    if (!term) return 1;
    if (values.some(value => value.startsWith(term))) return 2;
    if (values.some(value => value.split(/\s+/u).some(word => word.startsWith(term)))) return 1.5;
    return values.some(value => value.includes(term)) ? 1 : 0;
  };
  return people.map(person => ({ person, score: score(person) })).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.person.name.localeCompare(b.person.name)).slice(0, limit).map(item => item.person);
}

/**
 * Ids of people mentioned in text by display name or username. Matches whole
 * names only and prefers the longest name at each "@", so "@Mia Member" does
 * not also mention "Mia" and "@Alice" does not mention "Al".
 */
export function mentionedIds(text: string, people: readonly MentionPerson[]) {
  const lower = text.toLocaleLowerCase();
  const names = people.flatMap(person => [person.name, person.username ?? '']
    .filter(Boolean).map(value => ({ id: person.id, value: value.toLocaleLowerCase() })))
    .sort((a, b) => b.value.length - a.value.length);
  const found = new Set<string>();
  for (let at = lower.indexOf('@'); at >= 0; at = lower.indexOf('@', at + 1)) {
    if (at > 0 && /[\p{L}\p{N}_]/u.test(lower[at - 1])) continue;
    const match = names.find(({ value }) => lower.startsWith(value, at + 1) && /^$|^[\s.,;:!?)\]}'"’]/u.test(lower.slice(at + 1 + value.length, at + 2 + value.length)));
    if (match) found.add(match.id);
  }
  return [...found];
}

/**
 * An @mention picker for a text field: type "@" and a name, choose with the
 * arrow keys and Enter or Tab, or keep typing. Escape closes only the list.
 */
export function useMentionPicker({ value, onValue, people, field }: {
  value: string;
  onValue: (value: string) => void;
  people: MentionPerson[];
  field: RefObject<HTMLInputElement | HTMLTextAreaElement>;
}) {
  const listId = useId();
  const [open, setOpen] = useState<{ query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const options = useMemo(() => open ? mentionMatches(people, open.query) : [], [open, people]);
  const showing = Boolean(open && options.length);
  const update = (text: string, caret: number) => {
    const next = mentionQuery(text, caret);
    setOpen(next);
    setActive(0);
  };
  const choose = (person: MentionPerson) => {
    if (!open) return;
    const caret = field.current?.selectionStart ?? value.length;
    const inserted = `@${person.name} `;
    const next = value.slice(0, open.start) + inserted + value.slice(caret);
    onValue(next);
    setOpen(null);
    const position = open.start + inserted.length;
    requestAnimationFrame(() => {
      const input = field.current;
      // Escape or another click may have moved focus before this frame.
      // Later typing may also have changed the value and caret already.
      if (input && document.activeElement === input && input.value === next) input.setSelectionRange(position, position);
    });
  };
  const onChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    onValue(event.target.value);
    update(event.target.value, event.target.selectionStart ?? event.target.value.length);
  };
  /** Returns true when the key was for the list. */
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (!showing) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
      return true;
    }
    if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') {
      event.preventDefault();
      choose(options[active]);
      return true;
    }
    if (event.key === 'Escape') {
      // Close the list; the panel must not treat this Escape as "close".
      event.preventDefault();
      event.stopPropagation();
      setOpen(null);
      return true;
    }
    return false;
  };
  // The field keeps its textbox role (a multi-line combobox is poorly
  // supported); the list is announced through aria-activedescendant.
  const fieldProps = {
    'aria-autocomplete': 'list' as const,
    'aria-controls': showing ? listId : undefined,
    'aria-activedescendant': showing ? `${listId}-${active}` : undefined,
    onBlur: () => window.setTimeout(() => setOpen(null), 120),
  };
  const list: ReactNode = showing ? <ul className="mention-list" id={listId} role="listbox" aria-label="People to mention">
    {options.map((person, index) => <li key={person.id} id={`${listId}-${index}`} role="option" aria-selected={index === active}
      onMouseDown={event => { event.preventDefault(); choose(person); }} onMouseEnter={() => setActive(index)}>
      <span className="mention-avatar" style={{ background: person.color, color: avatarInk(person.color) }} aria-hidden="true">{person.name.slice(0, 1).toUpperCase()}</span>
      <span className="mention-name">{person.name}</span>
      {person.username ? <span className="mention-username">@{person.username}</span> : null}
    </li>)}
  </ul> : null;
  return { onChange, onKeyDown, fieldProps, list };
}
