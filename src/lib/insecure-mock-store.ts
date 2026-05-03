/**
 * In-memory document store for insecure/dev mode.
 * When NEXT_PUBLIC_ALLOW_INSECURE_AUTH=true, this store replaces Firestore
 * so that document CRUD works end-to-end in local development without Firebase.
 */

import { DocumentType } from '@/types/documents';
import { PERSONAL_WORKSPACE_ID } from '@/types/workspace';

export interface MockDoc {
  id: string;
  name: string;
  content: string;
  type: string;
  workspaceId: string;
  folder: string;
  ownerId: string;
  mimeType?: string | null;
  storagePath?: string | null;
  url?: string | null;
  order?: number;
  size?: number;
  createdAt: { seconds: number };
  updatedAt: { seconds: number };
  [key: string]: unknown;
}

let counter = 0;
const docs = new Map<string, MockDoc>();

// Seed with the default test document
const seedId = 'mock-doc-1';
docs.set(seedId, {
  id: seedId,
  name: 'Documento de Prueba.md',
  content: 'Este es un texto de prueba para la busqueda. La busqueda debe funcionar.',
  type: DocumentType.Text,
  workspaceId: PERSONAL_WORKSPACE_ID,
  folder: 'No estructurado',
  ownerId: 'test-user-insecure',
  createdAt: { seconds: Date.now() / 1000 },
  updatedAt: { seconds: Date.now() / 1000 }
});

export function mockCreateDoc(data: Partial<MockDoc> & { name: string; ownerId: string }): MockDoc {
  counter++;
  const id = `mock-doc-${Date.now()}-${counter}`;
  const now = Date.now() / 1000;
  const doc: MockDoc = {
    id,
    name: data.name,
    content: typeof data.content === 'string' ? data.content : '',
    type: data.type || DocumentType.Text,
    workspaceId: data.workspaceId || PERSONAL_WORKSPACE_ID,
    folder: data.folder || 'No estructurado',
    ownerId: data.ownerId,
    mimeType: data.mimeType ?? null,
    createdAt: { seconds: now },
    updatedAt: { seconds: now }
  };
  if (typeof data.order === 'number') doc.order = data.order;
  docs.set(id, doc);
  return doc;
}

export function mockGetDoc(id: string): MockDoc | undefined {
  return docs.get(id);
}

export function mockUpdateDoc(id: string, updates: Record<string, unknown>): boolean {
  const doc = docs.get(id);
  if (!doc) return false;
  const now = Date.now() / 1000;
  Object.assign(doc, updates, { updatedAt: { seconds: now } });
  return true;
}

export function mockDeleteDoc(id: string): boolean {
  return docs.delete(id);
}

export function mockListDocs(filters?: {
  workspaceId?: string;
  ownerId?: string;
}): MockDoc[] {
  const result: MockDoc[] = [];
  for (const doc of docs.values()) {
    if (filters?.workspaceId && doc.workspaceId !== filters.workspaceId) continue;
    if (filters?.ownerId && doc.ownerId !== filters.ownerId) continue;
    result.push(doc);
  }
  return result;
}
