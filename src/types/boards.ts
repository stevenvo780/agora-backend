export interface BoardColumn {
  id: string;
  name: string;
  order: number;
}

export interface BoardCard {
  id: string;
  title: string;
  description?: string;
  columnId: string;
  order: number;
  ownerId?: string;
  sourceDocId?: string;
  sourceDocName?: string;
  sourceFragment?: string;
  sourcePath?: string;
}
