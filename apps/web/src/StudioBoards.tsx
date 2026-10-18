import { type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode, useId, useRef } from 'react';
import { BoardPreview } from './BoardPreview';
import { DetailsMenu } from './DetailsMenu';
import { prepareEditor } from './editor-loader';
import { highlightParts, relativeTime, rovingTarget, type BoardLayout, type BoardSection } from './studio-view';
import type { Board, Role } from './studio-types';
import { UiIcon } from './UiIcon';

export const roleLabel = (role?: Role) => role === 'editor' ? 'Can edit' : role === 'commenter' ? 'Can comment' : role === 'viewer' ? 'View only' : '';
export const formatEdited = (value: string) => {
  const relative = relativeTime(value);
  return relative ? `Edited ${relative}` : 'Recently edited';
};

/** A small notebook: reads as "workbook", never as a checkbox. */
export function WorkbookGlyph({ className = '' }: { className?: string }) {
  return (
    <svg className={`workbook-glyph ${className}`} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="1.75" width="10.5" height="12.5" rx="1.75" fill="currentColor" opacity=".18" />
      <rect x="3" y="1.75" width="10.5" height="12.5" rx="1.75" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 1.9v12.2M8.25 5h3M8.25 7.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Highlights each match in plain text without ever interpreting it as HTML. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const parts = highlightParts(text, query);
  return <>{parts.map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</>;
}

export type BoardItemProps = {
  board: Board;
  query: string;
  workbookTitle?: string;
  showWorkbook: boolean;
  showRole: boolean;
  showExcerpt: boolean;
  highlighted: boolean;
  canDuplicate: boolean;
  canMove: boolean;
  onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
  onFavorite: (fromMenu: boolean) => void;
  onRename: () => void;
  onMove: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onTrash: () => void;
};

function BoardMenu({ item, tabIndex }: { item: BoardItemProps; tabIndex: number }) {
  const { board } = item;
  const canEdit = board.role === 'owner' || board.role === 'editor';
  const canManage = board.role === 'owner';
  return (
    <DetailsMenu className="board-menu">
      <summary aria-label={`Actions for ${board.title}`} title="Board actions" tabIndex={tabIndex}><UiIcon name="more" /></summary>
      <div className="board-menu-popover">
        <div className="board-menu-title" aria-hidden="true">{board.title}</div>
        <button type="button" onClick={() => item.onFavorite(true)}><UiIcon name="star" />{board.favorite ? 'Remove from favorites' : 'Add to favorites'}</button>
        {canEdit ? <button type="button" onClick={item.onRename}><UiIcon name="pen" />Rename…</button> : null}
        {canManage && item.canMove ? <button type="button" onClick={item.onMove}><UiIcon name="folder" />Move to…</button> : null}
        {item.canDuplicate ? <button type="button" onClick={item.onDuplicate}><UiIcon name="duplicate" />Duplicate</button> : null}
        {canEdit ? <button type="button" onClick={item.onExport}><UiIcon name="download" />Export archive</button> : null}
        {canManage ? <><hr /><button className="danger-action" type="button" onClick={item.onTrash}><UiIcon name="trash" />Move to trash</button></> : null}
      </div>
    </DetailsMenu>
  );
}

function StarButton({ item }: { item: BoardItemProps }) {
  const { board } = item;
  return (
    <button
      className={`favorite-button ${board.favorite ? 'active' : ''}`}
      type="button"
      tabIndex={-1}
      aria-pressed={board.favorite}
      aria-label={board.favorite ? `Remove ${board.title} from favorites` : `Add ${board.title} to favorites`}
      title={board.favorite ? 'Remove from favorites' : 'Add to favorites'}
      // A pointer shortcut: it must not move focus or scroll the page.
      onMouseDown={event => event.preventDefault()}
      onClick={() => item.onFavorite(false)}
    >
      <UiIcon name="star" />
    </button>
  );
}

function excerptOf(item: BoardItemProps) {
  const { board } = item;
  return item.showExcerpt && board.matchedText && board.matchedText !== board.title ? board.matchedText : '';
}

/** One link and one menu button per card; arrow keys move between cards. */
export function BoardCard({ item, active }: { item: BoardItemProps; active: boolean }) {
  const id = useId();
  const { board } = item;
  const role = item.showRole ? roleLabel(board.role) : '';
  const excerpt = excerptOf(item);
  return (
    <article className={`board-card${item.highlighted ? ' just-added' : ''}`} data-board-id={board.id}>
      <a className="board-card-link" href={`/boards/${board.id}`} title={board.title} tabIndex={active ? 0 : -1} aria-labelledby={`${id}-title`} aria-describedby={`${id}-meta`} onPointerEnter={prepareEditor} onFocus={prepareEditor} onClick={item.onOpen}>
        <BoardPreview board={board} />
        <span className="board-card-details">
          <strong id={`${id}-title`}>{board.private ? <UiIcon name="lock" /> : null}<span className="board-card-title"><Highlight text={board.title} query={item.query} /></span>{board.private ? <span className="visually-hidden"> (private)</span> : null}</strong>
          {/* Only the workbook name truncates; the edit time always stays visible. */}
          <span className="board-card-meta" id={`${id}-meta`}>
            {item.showWorkbook ? <span className="meta-workbook">{item.workbookTitle ?? 'Personal'}</span> : null}
            {role ? <span className="meta-role">{role}</span> : null}
            <span className="meta-edited">{formatEdited(board.updatedAt)}</span>
          </span>
          {excerpt ? <em className="search-match">“<Highlight text={excerpt} query={item.query} />”</em> : null}
        </span>
      </a>
      <StarButton item={item} />
      <BoardMenu item={item} tabIndex={active ? 0 : -1} />
    </article>
  );
}

/** A dense row: title, workbook, access and edit time at a glance. */
export function BoardRow({ item, active }: { item: BoardItemProps; active: boolean }) {
  const id = useId();
  const { board } = item;
  const excerpt = excerptOf(item);
  return (
    <li className={`board-row${item.highlighted ? ' just-added' : ''}`} data-board-id={board.id}>
      <a className="board-card-link board-row-link" href={`/boards/${board.id}`} title={board.title} tabIndex={active ? 0 : -1} aria-labelledby={`${id}-title`} aria-describedby={`${id}-meta`} onPointerEnter={prepareEditor} onFocus={prepareEditor} onClick={item.onOpen}>
        <span className="row-title" id={`${id}-title`}>
          <span className="row-name">{board.private ? <UiIcon name="lock" /> : null}<span className="board-card-title"><Highlight text={board.title} query={item.query} /></span>{board.private ? <span className="visually-hidden"> (private)</span> : null}</span>
          {excerpt ? <em className="search-match">“<Highlight text={excerpt} query={item.query} />”</em> : null}
        </span>
        <span className="row-meta" id={`${id}-meta`}>
          <span className="row-workbook">{item.workbookTitle ?? 'Personal'}</span>
          <span className="row-role">{board.role === 'owner' ? 'Owner' : roleLabel(board.role) || '—'}</span>
          <span className="row-edited">{relativeTime(board.updatedAt) || '—'}</span>
        </span>
      </a>
      <StarButton item={item} />
      <BoardMenu item={item} tabIndex={active ? 0 : -1} />
    </li>
  );
}

const ROVING_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];

/**
 * The board grid or list as one tab stop (the active card's link, then its
 * menu button). Arrow keys move between cards by row and column, as in the
 * WAI-ARIA grid pattern; Up/Down on a menu button still open its menu.
 */
export function BoardCollection({ sections, layout, activeId, onActive, itemProps }: {
  sections: BoardSection<Board>[];
  layout: BoardLayout;
  activeId: string;
  onActive: (id: string) => void;
  itemProps: (board: Board) => BoardItemProps;
}) {
  const container = useRef<HTMLDivElement>(null);
  const ids = sections.flatMap(section => section.boards.map(board => board.id));
  const current = ids.includes(activeId) ? activeId : ids[0];
  const focusCard = (card: Element | undefined, part: 'link' | 'menu') => {
    const target = card?.querySelector<HTMLElement>(part === 'menu' ? '.board-menu > summary' : '.board-card-link');
    if (!target) return;
    onActive((card as HTMLElement).dataset.boardId ?? '');
    target.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!ROVING_KEYS.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>('[data-board-id]');
    if (!card || target.closest('.board-menu-popover')) return;
    const cards = Array.from(container.current?.querySelectorAll<HTMLElement>('[data-board-id]') ?? []);
    const index = cards.indexOf(card);
    if (target.matches('.board-menu > summary')) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); focusCard(card, 'link'); }
      else if (event.key === 'ArrowRight' && layout === 'grid' && cards[index + 1]) { event.preventDefault(); focusCard(cards[index + 1], 'link'); }
      return;
    }
    if (layout === 'list' && event.key === 'ArrowRight') { event.preventDefault(); focusCard(card, 'menu'); return; }
    if (layout === 'list' && event.key === 'ArrowLeft') return;
    const rects = cards.map(item => item.getBoundingClientRect());
    const next = rovingTarget(rects, index, event.key);
    event.preventDefault();
    if (next !== index) focusCard(cards[next], 'link');
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-board-id]');
    if (card?.dataset.boardId && card.dataset.boardId !== current) onActive(card.dataset.boardId);
  };
  const list = (boards: Board[]): ReactNode => layout === 'list'
    ? <ul className="board-list">{boards.map(board => <BoardRow key={board.id} item={itemProps(board)} active={board.id === current} />)}</ul>
    : <div className="board-grid">{boards.map(board => <BoardCard key={board.id} item={itemProps(board)} active={board.id === current} />)}</div>;
  return (
    <div ref={container} className={`board-sections layout-${layout}`} onKeyDown={onKeyDown} onFocus={onFocus}>
      {sections.map(section => (
        <section key={section.key} className="board-section" aria-labelledby={section.title ? `section-${section.key}` : undefined} aria-label={section.title ? undefined : 'Boards'}>
          {section.title ? <h2 className="board-section-title" id={`section-${section.key}`}>{section.title}<span>{section.boards.length}</span></h2> : null}
          {layout === 'list' ? <div className="board-list-header" aria-hidden="true"><span className="header-cells"><span>Name</span><span className="row-workbook">Workbook</span><span className="row-role">Access</span><span className="row-edited">Edited</span></span></div> : null}
          {list(section.boards)}
        </section>
      ))}
    </div>
  );
}
