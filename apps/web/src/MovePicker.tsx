import { type InputHTMLAttributes, type ReactNode, useEffect, useId, useRef } from 'react';
import { workbookTree } from './studio-view';
import type { Folder, Workbook } from './studio-types';
import { WorkbookGlyph } from './StudioBoards';
import { UiIcon } from './UiIcon';

/** A text field that arrives with its current value selected, ready to replace. */
export function SelectedInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select();
  }, []);
  return <input ref={ref} {...props} />;
}

type MovePickerProps = {
  titleId: string;
  mode: 'move' | 'restore';
  board: { title: string; workbookId: string | null; private?: boolean };
  folders: Folder[];
  workbooks: Workbook[];
  busy: boolean;
  error: ReactNode;
  filter: string;
  onFilter: (value: string) => void;
  selected: string;
  onSelect: (workbookId: string) => void;
  onMove: (workbookId: string) => void;
  onCancel: () => void;
};

/**
 * Choose a destination by typing or with the arrow keys. Nothing is chosen
 * until someone picks or types, so Enter never moves a board by accident.
 */
export function MovePicker({ titleId, mode, board, folders, workbooks, busy, error, filter, onFilter, selected, onSelect, onMove, onCancel }: MovePickerProps) {
  const listId = useId();
  const tree = workbookTree(folders, workbooks, filter);
  const filed = tree.folders.filter(group => group.workbooks.length);
  const groups = [
    ...filed.map(group => ({ key: group.folder.id, label: group.folder.title, items: group.workbooks })),
    ...(tree.unfiled.length ? [{ key: 'unfiled', label: filed.length ? 'No folder' : '', items: tree.unfiled }] : []),
  ];
  const options = groups.flatMap(group => group.items).filter(item => item.id !== board.workbookId);
  const active = options.some(item => item.id === selected) ? selected : filter.trim() ? options[0]?.id ?? '' : '';
  const target = options.find(item => item.id === active);
  // Index-based ids: sanitizing workbook ids could make two of them collide.
  const positions = new Map(groups.flatMap(group => group.items).map((item, index) => [item.id, index]));
  const optionId = (id: string) => `${listId}-option-${positions.get(id) ?? 'none'}`;
  useEffect(() => {
    // Scroll only the list; scrollIntoView would also nudge the page behind the dialog.
    const option = active ? document.getElementById(optionId(active)) : null;
    const list = option?.closest<HTMLElement>('.move-options');
    if (!option || !list) return;
    const top = option.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top - 28;
    else if (top + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + option.offsetHeight - list.clientHeight + 4;
  }, [active]);
  const step = (offset: number) => {
    if (!options.length) return;
    const index = options.findIndex(item => item.id === active);
    onSelect(options[index < 0 ? (offset > 0 ? 0 : options.length - 1) : (index + offset + options.length) % options.length].id);
  };
  const verb = mode === 'restore' ? 'Restore' : 'Move';
  return (
    <form onSubmit={event => { event.preventDefault(); if (target && !busy) onMove(target.id); }}>
      <h2 id={titleId}>{mode === 'restore' ? `Restore “${board.title}” to…` : `Move “${board.title}”`}</h2>
      <p>{mode === 'restore'
        ? 'Its workbook is in the trash. Choose a workbook to put it back in.'
        : board.private ? 'This private board keeps its own sharing wherever it goes.' : 'It will be shared like the other boards in its new workbook.'}</p>
      {error}
      <label className="move-filter">
        <span className="visually-hidden">Find a workbook</span>
        <UiIcon name="search" />
        <SelectedInput
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(active) : undefined}
          placeholder="Find a workbook"
          value={filter}
          onChange={event => onFilter(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); step(1); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); step(-1); }
          }}
        />
      </label>
      <div className="move-options" id={listId} role="listbox" aria-label="Workbooks">
        {groups.map(group => (
          <div role="group" key={group.key} aria-label={group.label || 'Workbooks'}>
            {group.label ? <div className="move-group-label" aria-hidden="true"><UiIcon name="folder" /><span>{group.label}</span></div> : null}
            {group.items.map(item => {
              const current = item.id === board.workbookId;
              return (
                <div
                  key={item.id}
                  id={optionId(item.id)}
                  role="option"
                  className={`move-option${item.id === active ? ' active' : ''}${current ? ' current' : ''}`}
                  aria-selected={item.id === active}
                  aria-disabled={current || undefined}
                  title={item.title}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => { if (!current) onSelect(item.id); }}
                  onDoubleClick={() => { if (!current && !busy) onMove(item.id); }}
                >
                  <WorkbookGlyph />
                  <span className="tree-label">{item.title}</span>
                  {current ? <small>Current</small> : null}
                </div>
              );
            })}
          </div>
        ))}
        {!options.length ? <p className="move-empty" role="status">{filter.trim() ? `No workbooks match “${filter.trim()}”.` : `There are no other workbooks you can ${verb.toLowerCase()} this board to.`}</p> : null}
      </div>
      <div className="modal-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
        <button className={`primary-button${busy ? ' working' : ''}`} type="submit" disabled={busy || !target} title={target?.title}>
          {busy ? <><i className="button-spinner" aria-hidden="true" />{mode === 'restore' ? 'Restoring…' : 'Moving…'}</> : target ? <>{verb} to <span className="button-target">{target.title}</span></> : verb}
        </button>
      </div>
    </form>
  );
}
