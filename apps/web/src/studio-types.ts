/** Shapes the Studio receives from the catalog API. */
export type Role = 'owner' | 'editor' | 'commenter' | 'viewer';

export type Folder = {
  id: string;
  title: string;
  parentId?: string | null;
};

export type Workbook = {
  id: string;
  folderId: string | null;
  title: string;
  /** Filed by another owner in a folder this person cannot see. */
  filedElsewhere?: boolean;
  role?: Role;
};

export type Board = {
  id: string;
  title: string;
  workbookId: string | null;
  favorite: boolean;
  updatedAt: string;
  matchedText?: string;
  role?: Role;
  private?: boolean;
};

export type Catalog = {
  folders: Folder[];
  workbooks: Workbook[];
  boards: Board[];
};

export type TrashedBoard = {
  id: string;
  title: string;
  workbookId: string;
  workbookTitle: string | null;
  workbookDeletedAt: string | null;
  deletedAt: string;
  updatedAt: string;
  private: boolean;
};

export type TrashedWorkbook = { id: string; title: string; deletedAt: string; boardCount: number };

export type Trash = { boards: TrashedBoard[]; workbooks: TrashedWorkbook[] };
