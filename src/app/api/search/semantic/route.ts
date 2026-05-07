import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';
import { buildSemanticSearchResults, type SearchableDocument } from '@/lib/search/rank';
import { isSearchResultKind, type SearchResultKind, type SemanticSearchRequest } from '@/lib/search/types';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { DocumentType, isDocumentType } from '@/types/documents';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { getObjectBuffer, isNasConfigured } from '@/lib/nas-storage';

// 2000 cubre el WS más grande conocido (Filosofia ~1619 docs). Si crece más,
// subir o agregar paginación real con cursor. orderBy(updatedAt desc) asegura
// que si el cap se queda corto, los docs visibles son los más recientes.
const MAX_SCAN_DOCS = 2000;
const DEFAULT_LIMIT = 18;
const NON_SEARCHABLE_DOCUMENT_TYPES = new Set([
  DocumentType.Folder,
  DocumentType.Terminal,
  DocumentType.Files,
  DocumentType.Board
]);

// Hidratación desde MinIO sólo para docs LEGACY (sin searchableContent).
// Bajamos los límites porque el caso común ya no requiere MinIO.
const LEGACY_HYDRATE_MAX = 40;
const LEGACY_HYDRATE_BYTES = 256 * 1024;

const FAILED_PRECONDITION = 9 as const;

const isFirestoreIndexError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === FAILED_PRECONDITION || code === 'failed-precondition') return true;
  const msg = (error as { message?: unknown }).message;
  return typeof msg === 'string' && /requires an index/i.test(msg);
};

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

    // orderBy(updatedAt desc) → si el cap se queda corto, los docs más
    // recientes son visibles. Requiere composite index:
    //   collection: documents
    //   workspaceId ASC, updatedAt DESC   (para WS compartidos)
    //   ownerId ASC, workspaceId ASC, updatedAt DESC   (para personal)
    // Si Firestore lo pide, log con instrucciones para crearlo.
    let snapshot: FirebaseFirestore.QuerySnapshot;
    try {
      snapshot = await queryRef.orderBy('updatedAt', 'desc').limit(MAX_SCAN_DOCS).get();
    } catch (err) {
      if (isFirestoreIndexError(err)) {
        const msg = getErrorMessage(err);
        console.error(
          '[search/semantic] Composite index missing for workspaceId+updatedAt. ' +
          'Create it from the URL in the original Firestore error or via gcloud:\n' +
          '  gcloud firestore indexes composite create \\\n' +
          '    --collection-group=documents \\\n' +
          '    --field-config=field-path=workspaceId,order=ascending \\\n' +
          '    --field-config=field-path=updatedAt,order=descending\n' +
          'Original error: ' + msg
        );
        // Fallback sin orderBy para no devolver 500 al usuario.
        snapshot = await queryRef.limit(MAX_SCAN_DOCS).get();
      } else {
        throw err;
      }
    }

    const rawDocs = snapshot.docs.map(doc => (
      { id: doc.id, ...(doc.data() as Record<string, unknown>) } as Record<string, unknown> & { id: string }
    ));
    const filteredRaw = rawDocs.filter(item => !NON_SEARCHABLE_DOCUMENT_TYPES.has(item.type as DocumentType));

    // Estrategia de contenido:
    // 1) Si el doc tiene `searchableContent` populated → usar directo (cero IO).
    // 2) Si tiene `content` inline (legacy pre-NAS) → usar.
    // 3) Si no tiene nada y es text-ish con storagePath → hidratar desde MinIO
    //    (solo para docs sin denormalizar; los nuevos quedan cubiertos por (1)).
    const hydrated = new Map<string, string>();
    const legacyHydrate = filteredRaw
      .filter(item => {
        const hasSearchable = typeof item.searchableContent === 'string' && item.searchableContent.length > 0;
        if (hasSearchable) return false;
        const hasInline = typeof item.content === 'string' && item.content.length > 0;
        if (hasInline) return false;
        const path = typeof item.storagePath === 'string' ? item.storagePath : '';
        const t = typeof item.type === 'string' ? item.type : '';
        const mime = typeof item.mimeType === 'string' ? item.mimeType : '';
        const isTextish = t === DocumentType.Text || /text|markdown|json|xml|html/i.test(mime);
        return Boolean(path) && isTextish;
      })
      .slice(0, LEGACY_HYDRATE_MAX);

    if (legacyHydrate.length > 0 && isNasConfigured()) {
      const CONCURRENCY = 8;
      let cursor = 0;
      const worker = async () => {
        while (cursor < legacyHydrate.length) {
          const idx = cursor++;
          const item = legacyHydrate[idx];
          if (!item) continue;
          const path = item.storagePath as string;
          try {
            const buf = await getObjectBuffer(path);
            if (buf) hydrated.set(item.id, buf.subarray(0, LEGACY_HYDRATE_BYTES).toString('utf8'));
          } catch {
            /* ignorar fallos individuales */
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, legacyHydrate.length) }, worker));
    }

    const docs = filteredRaw
      .map(item => {
        const denormalized = typeof item.searchableContent === 'string' && item.searchableContent.length > 0
          ? item.searchableContent
          : null;
        const inline = typeof item.content === 'string' && item.content.length > 0 ? item.content : null;
        const fromMinio = hydrated.get(item.id) ?? null;
        const content = denormalized ?? inline ?? fromMinio ?? '';
        return {
          id: item.id,
          name: typeof item.name === 'string' ? item.name : 'Sin titulo',
          type: typeof item.type === 'string' && isDocumentType(item.type) ? item.type : undefined,
          content,
          folder: typeof item.folder === 'string' ? item.folder : '',
          workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : workspaceId,
          mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
          url: typeof item.url === 'string' ? item.url : undefined,
          storagePath: typeof item.storagePath === 'string' ? item.storagePath : undefined,
          ownerId: typeof item.ownerId === 'string' ? item.ownerId : auth.uid,
          updatedAt: item.updatedAt,
          createdAt: item.createdAt,
          size: typeof item.size === 'number' ? item.size : undefined
        } satisfies SearchableDocument;
      });

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
