export enum DocumentType {
  Text = 'text',
  File = 'file',
  Folder = 'folder',
  Terminal = 'terminal',
  Files = 'files',
  Board = 'board',
  STRunner = 'st-runner',
  SemanticBrowser = 'semantic-browser',
  Formalizer = 'formalizer',
  AgoraAI = 'agora-ai'
}

export type DocumentTypeId = `${DocumentType}`;

export const DOCUMENT_TYPES = Object.values(DocumentType) as DocumentTypeId[];

const DOCUMENT_TYPE_SET = new Set<DocumentTypeId>(DOCUMENT_TYPES);

export const isDocumentType = (value: string): value is DocumentTypeId =>
  DOCUMENT_TYPE_SET.has(value as DocumentTypeId);
