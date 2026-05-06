import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';
import { buildSemanticSearchResults, type SearchableDocument } from '@/lib/search/rank';
import { isSearchResultKind, type SearchResultKind, type SemanticSearchRequest } from '@/lib/search/types';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { DocumentType, isDocumentType } from '@/types/documents';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { getObjectBuffer, isNasConfigured } from '@/lib/nas-storage';

const MAX_SCAN_DOCS = 200;
const DEFAULT_LIMIT = 18;
const NON_SEARCHABLE_DOCUMENT_TYPES = new Set([
  DocumentType.Folder,
  DocumentType.Terminal,
  DocumentType.Files,
  DocumentType.Board
]);

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const body = (await req.json()) as Partial<SemanticSearchRequest>;
    const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId.trim()
      ? body.workspaceId.trim()
      : PERSONAL_WORKSPACE_ID;
    const query = typeof body.query === 'string' ? body.query : '';
    const limit = typeof body.limit === 'number' ? body.limit : DEFAULT_LIMIT;
    const offset = typeof body.offset === 'number' ? body.offset : 0;
    const kinds = Array.isArray(body.kinds)
      ? body.kinds.filter((kind): kind is SearchResultKind => typeof kind === 'string' && isSearchResultKind(kind))
      : undefined;

    let queryRef: FirebaseFirestore.Query = adminDb.collection('documents');

    if (!isPersonalWorkspaceId(workspaceId)) {
      const member = await isWorkspaceMember(workspaceId, auth.uid);
      if (!member) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      queryRef = queryRef.where('workspaceId', '==', workspaceId);
    } else {
      queryRef = queryRef.where('ownerId', '==', auth.uid).where('workspaceId', '==', PERSONAL_WORKSPACE_ID);
    }

    // NOTE: non-searchable types are filtered client-side below.
    // A Firestore `not-in` combined with equality filters on other fields
    // requires a composite index that is not deployed; doing it here caused 500s.

    const snapshot = await queryRef.limit(MAX_SCAN_DOCS).get();
    const rawDocs = snapshot.docs.map(doc => (
      { id: doc.id, ...(doc.data() as Record<string, unknown>) } as Record<string, unknown> & { id: string }
    ));
    const filteredRaw = rawDocs.filter(item => !NON_SEARCHABLE_DOCUMENT_TYPES.has(item.type as DocumentType));

    // Hidratar `content` desde MinIO para docs con storagePath y sin content
    // inline (post migración a NAS). Sin esto, el ranker sólo matchea por
    // name/folder y la búsqueda por contenido falla (bug #6). Limitamos a docs
    // razonables para no explotar el endpoint.
    const MAX_HYDRATE = 80;
    const MAX_BYTES_PER_DOC = 256 * 1024; // 256KB; corta docs muy grandes
    const hydrateCandidates = filteredRaw
      .filter(item => {
        const hasInline = typeof item.content === 'string' && item.content.length > 0;
        const path = typeof item.storagePath === 'string' ? item.storagePath : '';
        const t = typeof item.type === 'string' ? item.type : '';
        const mime = typeof item.mimeType === 'string' ? item.mimeType : '';
        const isTextish = t === DocumentType.Text || /text|markdown|json|xml|html/i.test(mime);
        return !hasInline && path && isTextish;
      })
      .slice(0, MAX_HYDRATE);

    const hydrated = new Map<string, string>();
    if (hydrateCandidates.length > 0 && isNasConfigured()) {
      const CONCURRENCY = 8;
      let cursor = 0;
      const worker = async () => {
        while (cursor < hydrateCandidates.length) {
          const idx = cursor++;
          const item = hydrateCandidates[idx];
          if (!item) continue;
          const path = item.storagePath as string;
          try {
            const buf = await getObjectBuffer(path);
            if (buf) hydrated.set(item.id, buf.subarray(0, MAX_BYTES_PER_DOC).toString('utf8'));
          } catch {
            /* ignorar fallos individuales */
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, hydrateCandidates.length) }, worker));
    }

    const docs = filteredRaw
      .map(item => ({
        id: item.id,
        name: typeof item.name === 'string' ? item.name : 'Sin titulo',
        type: typeof item.type === 'string' && isDocumentType(item.type) ? item.type : undefined,
        content: hydrated.get(item.id) ?? (typeof item.content === 'string' ? item.content : ''),
        folder: typeof item.folder === 'string' ? item.folder : '',
        workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : workspaceId,
        mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
        url: typeof item.url === 'string' ? item.url : undefined,
        storagePath: typeof item.storagePath === 'string' ? item.storagePath : undefined,
        ownerId: typeof item.ownerId === 'string' ? item.ownerId : auth.uid,
        updatedAt: item.updatedAt,
        createdAt: item.createdAt,
        size: typeof item.size === 'number' ? item.size : undefined
      } satisfies SearchableDocument));

    const { results, totalCandidates, offset: resultOffset, hasMore } = buildSemanticSearchResults({
      docs,
      query,
      limit,
      offset,
      kinds
    });

    return NextResponse.json({
      results,
      meta: {
        query,
        workspaceId,
        scannedDocuments: docs.length,
        totalCandidates,
        offset: resultOffset,
        hasMore,
        mode: 'heuristic-v1'
      }
    });
  } catch (error: unknown) {
    console.error('Error semantic search:', getErrorMessage(error));
    return NextResponse.json({ error: getErrorMessage(error, 'Search error') }, { status: 500 });
  }
}
