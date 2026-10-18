import { plural, relativeTime } from './studio-view';
import type { Trash, TrashedBoard, TrashedWorkbook } from './studio-types';
import { WorkbookGlyph } from './StudioBoards';
import { UiIcon } from './UiIcon';


/**
 * Everything this person owns that is in the trash. Nothing is removed from
 * the trash automatically, so the copy promises only what is true.
 */
export function StudioTrash({ trash, loading, failed, busyId, onRetry, onRestoreBoard, onRestoreWorkbook }: {
  trash: Trash | null;
  loading: boolean;
  failed: boolean;
  busyId: string;
  onRetry: () => void;
  onRestoreBoard: (board: TrashedBoard) => void;
  onRestoreWorkbook: (workbook: TrashedWorkbook) => void;
}) {
  if (failed) return (
    <section className="workspace-empty compact" aria-labelledby="empty-title">
      <div className="studio-empty-symbol" aria-hidden="true"><UiIcon name="trash" /></div>
      <div className="studio-empty-copy">
        <h2 id="empty-title">The trash couldn’t be loaded</h2>
        <p>Check your connection, then try again.</p>
        <div className="empty-actions"><button type="button" onClick={onRetry}>Try again</button></div>
      </div>
    </section>
  );
  if (loading && !trash) return (
    <ul className="trash-list" aria-busy="true" aria-label="Loading the trash">
      {[0, 1, 2].map(item => <li className="trash-row skeleton-row" key={item} />)}
    </ul>
  );
  if (!trash || (!trash.boards.length && !trash.workbooks.length)) return (
    <section className="workspace-empty compact" aria-labelledby="empty-title">
      <div className="studio-empty-symbol" aria-hidden="true"><UiIcon name="trash" /></div>
      <div className="studio-empty-copy">
        <h2 id="empty-title">The trash is empty</h2>
        <p>Boards and workbooks you move to the trash appear here, so you can restore them.</p>
      </div>
    </section>
  );
  return (
    <div className="trash-sections">
      {trash.workbooks.length ? (
        <section aria-labelledby="trash-workbooks">
          <h2 className="board-section-title" id="trash-workbooks">Workbooks<span>{trash.workbooks.length}</span></h2>
          <ul className="trash-list">
            {trash.workbooks.map(workbook => (
              <li className="trash-row" key={workbook.id} data-trash-id={workbook.id}>
                <WorkbookGlyph className="trash-icon" />
                <span className="trash-copy">
                  <strong title={workbook.title}>{workbook.title}</strong>
                  <small>{workbook.boardCount ? `With ${plural(workbook.boardCount, 'board')}` : 'No boards'} · Trashed {relativeTime(workbook.deletedAt)}</small>
                </span>
                <button className="secondary-button" type="button" disabled={Boolean(busyId)} aria-label={`Restore ${workbook.title}`} onClick={() => onRestoreWorkbook(workbook)}>
                  {busyId === workbook.id ? <><i className="button-spinner" aria-hidden="true" />Restoring…</> : 'Restore'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {trash.boards.length ? (
        <section aria-labelledby="trash-boards">
          <h2 className="board-section-title" id="trash-boards">Boards<span>{trash.boards.length}</span></h2>
          <ul className="trash-list">
            {trash.boards.map(board => (
              <li className="trash-row" key={board.id} data-trash-id={board.id}>
                <span className="trash-icon board" aria-hidden="true"><UiIcon name="sticky" /></span>
                <span className="trash-copy">
                  <strong title={board.title}>{board.private ? <UiIcon name="lock" /> : null}{board.title}</strong>
                  <small>
                    {board.workbookDeletedAt ? 'Its workbook is also in the trash' : board.workbookTitle ? <>From <span className="trash-workbook">{board.workbookTitle}</span></> : 'From a shared workbook'}
                    {' · '}Trashed {relativeTime(board.deletedAt)}
                  </small>
                </span>
                <button className="secondary-button" type="button" disabled={Boolean(busyId)} aria-label={`Restore ${board.title}`} onClick={() => onRestoreBoard(board)}>
                  {busyId === board.id ? <><i className="button-spinner" aria-hidden="true" />Restoring…</> : board.workbookDeletedAt ? 'Restore to…' : 'Restore'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
