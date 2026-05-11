
import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, fail, confirm, clamp, excerpt, toEpoch, formatTimestamp, truncateText, containsQueryTokens,
  ensureWorkspaceAccess, fetchWorkspaceDoc, fetchDocumentForUser, fetchDocumentForRead,
  loadDocumentFullContent,
  loadWorkspaceDocumentsPage,
  buildPageMeta,
  encodeDocumentPageCursor,
  decodeDocumentPageCursor,
  resolvePageSize,
  summarizeDocumentMeta, syncTextDocumentToStorage, maybeDeleteStorageObject,
  listWorkspaceSnippets, loadBoardStateIfExists, loadSemanticState,
  fetchWorkerStatus,
  normalizeFolderPath, adminDb, FieldValue,
  DocumentType, PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId,
  DEFAULT_PAGE_SIZE, DEFAULT_DOC_LIMIT, MAX_DOC_LIMIT,
  type StoredDocument, type StoredSnippet, type StoredBoardColumn, type StoredBoardCard
} from './shared';
import { Timestamp } from 'firebase-admin/firestore';
import { EMPTY_SEMANTIC_WORKSPACE_STATE } from '@/lib/semantic/workspace-state';
import { invalidateAgoraWorkspaceContext } from '@/lib/agora-ai/context';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

/**
 * Reúne todos los paths de carpeta del workspace, INCLUYENDO carpetas vacías
 * registradas como documentos type=folder. La carpeta vacía vive en Firestore
 * como un doc con type='folder', folder=<parentPath>, name=<folderName>;
 * su path real es `<folder>/<name>`.
 */
function collectWorkspaceFolders(documents: StoredDocument[]): {
  folders: string[];
  emptyFolders: string[];
  folderDocCountMap: Record<string, number>;
} {
  const allFolders = new Set<string>();
  const folderDocCount: Record<string, number> = {};

  for (const doc of documents) {
    const isFolder = doc.type === DocumentType.Folder;
    if (isFolder) {
      const parent = typeof doc.folder === 'string' ? doc.folder : '';
      const name = typeof doc.name === 'string' ? doc.name : '';
      if (name) {
        const folderPath = normalizeFolderPath(parent ? `${parent}/${name}` : name);
        allFolders.add(folderPath);
      }
    } else {
      const folderPath = normalizeFolderPath(doc.folder);
      allFolders.add(folderPath);
      folderDocCount[folderPath] = (folderDocCount[folderPath] ?? 0) + 1;
    }
  }

  const emptyFolders: string[] = [];
  for (const folder of allFolders) {
    if ((folderDocCount[folder] ?? 0) === 0) emptyFolders.push(folder);
  }

  return {
    folders: Array.from(allFolders).sort(),
    emptyFolders: emptyFolders.sort(),
    folderDocCountMap: folderDocCount
  };
}

async function inspectWorkspace(call: AgentToolCall, ctx: AgentExecutionContext) {
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 40, 5, 100);
  const pageSize = resolvePageSize(call.args.pageSize ?? call.args.docPageSize, DEFAULT_PAGE_SIZE);
  const cursor = typeof call.args.cursor === 'string' ? call.args.cursor : null;
  const includeWorker = call.args.includeWorker === true;
  const [workspace, page, snippets, semantic, board, worker] = await Promise.all([
    fetchWorkspaceDoc(ctx.workspaceId, ctx.uid),
    loadWorkspaceDocumentsPage(ctx, { limit: pageSize, cursor }),
    listWorkspaceSnippets(ctx).catch(() => [] as StoredSnippet[]),
    loadSemanticState(ctx).catch(() => EMPTY_SEMANTIC_WORKSPACE_STATE),
    loadBoardStateIfExists(ctx).catch(() => ({ columns: [] as StoredBoardColumn[], cards: [] as StoredBoardCard[] })),
    includeWorker ? fetchWorkerStatus(ctx, 3000) : Promise.resolve(null)
  ]);
  const documents = page.documents;

  const { folders, emptyFolders, folderDocCountMap } = collectWorkspaceFolders(documents);

  const textDocs = documents.filter((doc: StoredDocument) => (doc.type || DocumentType.Text) !== DocumentType.Folder);
  const folderDocs = documents.filter((doc: StoredDocument) => doc.type === DocumentType.Folder);
  const recentDocuments = documents
    .slice()
    .sort((left: StoredDocument, right: StoredDocument) => toEpoch(right.updatedAt) - toEpoch(left.updatedAt))
    .slice(0, limit)
    .map(summarizeDocumentMeta);

  const pageMeta = buildPageMeta(page.scannedThisPage, page.nextCursor);
  const continuationNote = pageMeta.hasMore
    ? ` (página de ${page.scannedThisPage}; quedan más documentos — itera con cursor para escanear todo el workspace)`
    : '';
  return ok(call, `Inventarié el workspace: ${documents.length} documento(s)${continuationNote}, ${folders.length} carpeta(s) (${emptyFolders.length} vacía${emptyFolders.length === 1 ? '' : 's'}), ${snippets.length} snippet(s), ${semantic.concepts.length} concepto(s).`, {
    workspace: {
      id: String(workspace.id),
      name: String(workspace.name || 'Workspace'),
      type: String(workspace.type || (isPersonalWorkspaceId(ctx.workspaceId) ? 'personal' : 'shared')),
      membersCount: Array.isArray(workspace.members) ? workspace.members.length : 1
    },
    page: pageMeta,
    inventory: {
      documentCount: documents.length,
      textDocumentCount: textDocs.length,
      folderDocumentCount: folderDocs.length,
      folders: folders.slice(0, limit),
      emptyFolders: emptyFolders.slice(0, limit),
      folderDocCountMap,
      recentDocuments,
      snippets: snippets.slice(0, limit).map((snippet: StoredSnippet) => ({
        id: snippet.id,
        title: snippet.title || 'Sin título',
        category: snippet.category || 'general',
        preview: excerpt(snippet.markdown || snippet.description || '', 120)
      })),
      board: {
        columnCount: board.columns.length,
        cardCount: board.cards.length,
        columns: board.columns.slice(0, limit).map((column: StoredBoardColumn) => ({ id: column.id, name: column.name || 'Sin título' })),
        cards: board.cards.slice(0, limit).map((card: StoredBoardCard) => ({
          id: card.id,
          title: card.title || 'Sin título',
          columnId: card.columnId || '',
          preview: excerpt(card.description || '', 120)
        }))
      },
      semantic: {
        conceptCount: semantic.concepts.length,
        relationCount: semantic.relations.length,
        fragmentCount: semantic.fragments.length,
        concepts: semantic.concepts.slice(0, limit).map((concept: { id: string; title: string; definition?: string; excerpt?: string; logicProfile?: string | null }) => ({
          id: concept.id,
          title: concept.title,
          definition: excerpt(concept.definition || concept.excerpt || '', 160),
          logicProfile: concept.logicProfile || null
        }))
      },
      worker
    }
  });
}

async function searchWorkspace(call: AgentToolCall, ctx: AgentExecutionContext) {
  const queryText = String(call.args.query || '').trim();
  if (!queryText) throw new Error('query es requerido');
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 10, 1, 25);
  const pageSize = resolvePageSize(call.args.pageSize, DEFAULT_PAGE_SIZE);
  const cursor = typeof call.args.cursor === 'string' ? call.args.cursor : null;
  const [page, snippets, semantic, board] = await Promise.all([
    loadWorkspaceDocumentsPage(ctx, { limit: pageSize, cursor }),
    listWorkspaceSnippets(ctx).catch(() => [] as StoredSnippet[]),
    loadSemanticState(ctx).catch(() => EMPTY_SEMANTIC_WORKSPACE_STATE),
    loadBoardStateIfExists(ctx).catch(() => ({ columns: [] as StoredBoardColumn[], cards: [] as StoredBoardCard[] }))
  ]);
  const documents = page.documents;

  const documentResults = documents
    .filter((doc: StoredDocument) => containsQueryTokens(
      [doc.name, doc.folder, doc.searchableContent || doc.content].map(String).join('\n'),
      queryText
    ))
    .slice(0, limit)
    .map(summarizeDocumentMeta);
  const snippetResults = snippets
    .filter((snippet: StoredSnippet) => containsQueryTokens([snippet.title, snippet.description, snippet.category, snippet.markdown].map(String).join('\n'), queryText))
    .slice(0, limit)
    .map((snippet: StoredSnippet) => ({
      id: snippet.id,
      title: snippet.title || 'Sin título',
      category: snippet.category || 'general',
      preview: excerpt(snippet.markdown || snippet.description || '', 180)
    }));
  const conceptResults = semantic.concepts
    .filter((concept: { title: string; definition?: string; formula?: string; excerpt?: string }) => containsQueryTokens([concept.title, concept.definition, concept.formula, concept.excerpt].map(String).join('\n'), queryText))
    .slice(0, limit)
    .map((concept: { id: string; title: string; definition?: string; excerpt?: string; formula?: string }) => ({
      id: concept.id,
      title: concept.title,
      definition: excerpt(concept.definition || concept.excerpt || '', 180),
      formula: concept.formula || ''
    }));
  const cardResults = board.cards
    .filter((card: StoredBoardCard) => containsQueryTokens([card.title, card.description, card.sourceDocName, card.sourceFragment].map(String).join('\n'), queryText))
    .slice(0, limit)
    .map((card: StoredBoardCard) => ({
      id: card.id,
      title: card.title || 'Sin título',
      columnId: card.columnId || '',
      preview: excerpt(card.description || card.sourceFragment || '', 180)
    }));

  const total = documentResults.length + snippetResults.length + conceptResults.length + cardResults.length;
  const pageMeta = buildPageMeta(page.scannedThisPage, page.nextCursor);
  const continuationNote = pageMeta.hasMore ? ` (página de ${page.scannedThisPage} doc(s); itera con cursor para escanear más)` : '';
  return ok(call, `La búsqueda global devolvió ${total} resultado(s)${continuationNote}.`, {
    query: queryText,
    page: pageMeta,
    results: {
      documents: documentResults,
      snippets: snippetResults,
      concepts: conceptResults,
      boardCards: cardResults
    }
  });
}

async function readWorkspaceBundle(call: AgentToolCall, ctx: AgentExecutionContext) {
  const maxDocuments = clamp(typeof call.args.maxDocuments === 'number' ? call.args.maxDocuments : 12, 1, 50);
  const maxCharsPerDocument = clamp(typeof call.args.maxCharsPerDocument === 'number' ? call.args.maxCharsPerDocument : 4000, 500, 12000);
  const includeContent = call.args.includeContent !== false;
  const includeSnippets = call.args.includeSnippets === true;
  const includeSemantic = call.args.includeSemantic === true;
  const folder = typeof call.args.folder === 'string' && call.args.folder.trim()
    ? normalizeFolderPath(call.args.folder)
    : '';
  const queryText = typeof call.args.query === 'string' ? call.args.query.trim() : '';
  const documentIds = Array.isArray(call.args.documentIds)
    ? call.args.documentIds.map(String).map((id) => id.trim()).filter(Boolean)
    : [];

  const pageSize = resolvePageSize(call.args.pageSize, DEFAULT_PAGE_SIZE);
  const cursor = typeof call.args.cursor === 'string' ? call.args.cursor : null;

  let docs: StoredDocument[];
  let pageMeta = buildPageMeta(0, null);
  if (documentIds.length > 0) {
    docs = await Promise.all(documentIds.slice(0, maxDocuments).map((id) => fetchDocumentForUser(id, ctx)));
    pageMeta = buildPageMeta(docs.length, null);
  } else {
    const loaded = await loadWorkspaceDocumentsPage(ctx, { limit: pageSize, cursor });
    pageMeta = buildPageMeta(loaded.scannedThisPage, loaded.nextCursor);
    let filtered = loaded.documents;
    if (folder) {
      filtered = filtered.filter((doc) => {
        const docFolder = normalizeFolderPath(doc.folder);
        return docFolder === folder || docFolder.startsWith(`${folder}/`);
      });
    }
    if (queryText) {
      filtered = filtered.filter((doc) => containsQueryTokens(
        [doc.name, doc.folder, doc.searchableContent || doc.content].map(String).join('\n'),
        queryText
      ));
    }
    docs = filtered
      .sort((left, right) => toEpoch(right.updatedAt) - toEpoch(left.updatedAt))
      .slice(0, maxDocuments);
  }

  const docsWithContent = includeContent
    ? await Promise.all(docs.map(async (doc) => {
        const hydrated = await loadDocumentFullContent(doc, { maxBytes: maxCharsPerDocument });
        return {
          ...summarizeDocumentMeta(doc),
          content: truncateText(hydrated.content, maxCharsPerDocument),
          truncated: hydrated.truncated || hydrated.content.length > maxCharsPerDocument,
          contentSource: hydrated.source,
          mimeType: doc.mimeType || null
        };
      }))
    : docs.map((doc) => ({ ...summarizeDocumentMeta(doc), mimeType: doc.mimeType || null }));

  const bundle: Record<string, unknown> = { documents: docsWithContent };

  if (includeSnippets) {
    const snippets = await listWorkspaceSnippets(ctx);
    bundle.snippets = snippets.slice(0, 20).map((snippet) => ({
      id: snippet.id,
      title: snippet.title || 'Sin título',
      category: snippet.category || 'general',
      markdown: truncateText(snippet.markdown || '', Math.min(maxCharsPerDocument, 3000))
    }));
  }

  if (includeSemantic) {
    const semantic = await loadSemanticState(ctx);
    bundle.semantic = {
      concepts: semantic.concepts.slice(0, 50),
      relations: semantic.relations.slice(0, 50),
      fragments: semantic.fragments.slice(0, 30)
    };
  }

  const continuationNote = pageMeta.hasMore ? ` (página de ${pageMeta.scannedThisPage} doc(s); itera con cursor para más)` : '';
  return ok(call, `Leí un paquete de contexto con ${docs.length} documento(s)${continuationNote}.`, {
    filters: { folder, query: queryText, documentIds },
    page: pageMeta,
    bundle
  });
}

async function listDocuments(call: AgentToolCall, ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const folder = typeof call.args.folder === 'string' && call.args.folder.trim()
    ? normalizeFolderPath(call.args.folder)
    : null;
  const type = typeof call.args.type === 'string' ? call.args.type : null;
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : DEFAULT_DOC_LIMIT, 1, MAX_DOC_LIMIT);
  const pageSize = resolvePageSize(call.args.pageSize, DEFAULT_PAGE_SIZE);
  const cursorParam = typeof call.args.cursor === 'string' ? call.args.cursor : null;
  const cursor = decodeDocumentPageCursor(cursorParam);

  let query: FirebaseFirestore.Query = adminDb.collection('documents');
  if (isPersonalWorkspaceId(ctx.workspaceId)) {
    query = query.where('ownerId', '==', ctx.uid);
    query = query.where('workspaceId', '==', PERSONAL_WORKSPACE_ID);
  } else {
    query = query.where('workspaceId', '==', ctx.workspaceId);
  }
  if (type) {
    query = query.where('type', '==', type);
  }

  let snap: FirebaseFirestore.QuerySnapshot;
  let orderedByUpdatedAt = true;
  try {
    let q = query.orderBy('updatedAt', 'desc').orderBy('__name__', 'asc');
    if (cursor) {
      q = q.startAfter(Timestamp.fromMillis(cursor.updatedAtMs), cursor.id);
    }
    snap = await q.limit(pageSize).get();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const msg = (err as { message?: unknown }).message;
    const indexErr = code === 9 || code === 'failed-precondition'
      || (typeof msg === 'string' && /requires an index/i.test(msg));
    if (indexErr) {
      console.warn('[list_documents] missing composite index, fallback sin orderBy.');
      orderedByUpdatedAt = false;
      snap = await query.limit(pageSize).get();
    } else {
      throw err;
    }
  }
  const allDocs = snap.docs
    .map(doc => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) } as StoredDocument));

  let nextCursor: string | null = null;
  if (orderedByUpdatedAt && snap.size >= pageSize && snap.docs.length > 0) {
    const last = snap.docs[snap.docs.length - 1];
    if (last) {
      const rawUpdated = (last.data() as { updatedAt?: unknown }).updatedAt;
      const ms = toEpoch(rawUpdated);
      if (ms > 0) {
        nextCursor = encodeDocumentPageCursor({ updatedAtMs: ms, id: last.id });
      }
    }
  }
  const pageMeta = buildPageMeta(allDocs.length, nextCursor);

  // Try exact folder match first; if 0 results, fall back to fuzzy match
  // (case-insensitive, whitespace-stripped) to handle agent typos like "Clase 3" vs "Clase3"
  const fuzzyFolder = (v: string) => v.toLowerCase().replace(/\s+/g, '');
  let filtered = folder
    ? allDocs.filter(doc => {
      const docFolder = normalizeFolderPath(doc.folder);
      // Exact match OR document is inside a subfolder (startsWith + '/')
      return docFolder === folder || docFolder.startsWith(`${folder}/`);
    })
    : allDocs;
  if (folder && filtered.length === 0) {
    const target = fuzzyFolder(folder);
    filtered = allDocs.filter(doc => {
      const f = fuzzyFolder(normalizeFolderPath(doc.folder));
      return f === target || f.startsWith(`${target}/`) || f.startsWith(target);
    });
  }
  // Also try contains if still no results (e.g. "Clase3" matches "filosofiaDeLaCiudad/Clase3")
  if (folder && filtered.length === 0) {
    const target = fuzzyFolder(folder);
    filtered = allDocs.filter(doc => {
      const f = fuzzyFolder(normalizeFolderPath(doc.folder));
      return f.includes(target) || target.includes(f);
    });
  }

  // Sort by updatedAt descending so most recent docs appear first
  const sorted = filtered.sort((a, b) => {
    const aTime = toEpoch(a['updatedAt']);
    const bTime = toEpoch(b['updatedAt']);
    return bTime - aTime;
  });

  const documents = sorted
    .slice(0, limit)
    .map(doc => ({
      id: doc.id,
      name: doc.name || 'Sin título',
      type: doc.type || DocumentType.Text,
      folder: normalizeFolderPath(doc.folder),
      updatedAt: formatTimestamp(doc['updatedAt'])
    }));

  const continuationNote = pageMeta.hasMore
    ? ` (página de ${pageMeta.scannedThisPage}; hay más — itera con cursor=${pageMeta.nextCursor ? '<nextCursor>' : 'null'} para la siguiente)`
    : '';
  return ok(call, `Encontré ${documents.length} documento(s)${folder ? ` en "${folder}" (incluye subcarpetas)` : ''}${continuationNote}.`, {
    documents,
    total: sorted.length,
    page: pageMeta,
    nextCursor: pageMeta.nextCursor
  });
}

async function readDocument(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const maxBytes = typeof call.args.maxBytes === 'number'
    ? clamp(call.args.maxBytes, 1024, 1_500_000)
    : 1_000_000;

  const resolved = await fetchDocumentForRead(documentId, ctx);
  if (resolved.kind === 'not_found') {
    throw new Error(`Documento no encontrado: "${documentId}". Usa list_documents para ver los documentos disponibles.`);
  }
  if (resolved.kind === 'ambiguous') {
    const names = resolved.candidates.slice(0, 5).map(c => `"${c.name}"`).join(', ');
    return ok(call, `Hay ${resolved.candidates.length} documento(s) que coinciden con "${documentId}" (${names}). Elige uno por id y vuelve a llamar.`, {
      ambiguous: true,
      query: documentId,
      candidates: resolved.candidates
    });
  }

  const doc = resolved.document;
  const hydrated = await loadDocumentFullContent(doc, { maxBytes });
  const summary = hydrated.source === 'storage'
    ? `Leí "${doc.name || 'Sin título'}" desde MinIO (${hydrated.bytesRead} bytes${hydrated.truncated ? ', truncado' : ''}).`
    : hydrated.source === 'firestore'
      ? `Leí "${doc.name || 'Sin título'}" desde Firestore cache (${hydrated.bytesRead} bytes${hydrated.truncated ? ', truncado' : ''}). Si el contenido parece desactualizado, el doc no tenía storagePath.`
      : `"${doc.name || 'Sin título'}" está vacío o no tiene contenido textual.`;
  return ok(call, summary, {
    ambiguous: false,
    document: {
      id: doc.id,
      name: doc.name || 'Sin título',
      type: doc.type || DocumentType.Text,
      folder: normalizeFolderPath(doc.folder),
      content: hydrated.content,
      contentSource: hydrated.source,
      bytesRead: hydrated.bytesRead,
      truncated: hydrated.truncated,
      mimeType: doc.mimeType || null,
      storagePath: doc.storagePath || null
    }
  });
}

async function createDocument(call: AgentToolCall, ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const title = String(call.args.title || '').trim() || 'Nuevo documento';
  const content = typeof call.args.content === 'string' ? call.args.content : '';
  const type = call.args.type === DocumentType.Folder ? DocumentType.Folder : DocumentType.Text;
  const folder = normalizeFolderPath(typeof call.args.folder === 'string' ? call.args.folder : undefined);

  const payload: Record<string, unknown> = {
    workspaceId: ctx.workspaceId,
    ownerId: ctx.uid,
    name: title,
    type,
    folder,
    mimeType: type === DocumentType.Folder ? null : 'text/markdown',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdBy: ctx.uid,
    lastUpdatedBy: ctx.uid
  };

  const ref = adminDb.collection('documents').doc();
  if (type === DocumentType.Folder) {
    await ref.set(payload);
  } else {
    await ref.set(payload);
    await syncTextDocumentToStorage({
      id: ref.id,
      name: title,
      content,
      type,
      folder,
      workspaceId: ctx.workspaceId,
      ownerId: ctx.uid,
      mimeType: 'text/markdown'
    }, content, {
      docRef: ref,
      source: 'agent-create',
      writerId: ctx.uid
    });
  }

  return ok(
    call,
    type === DocumentType.Folder ? `Creé la carpeta "${title}".` : `Creé el documento "${title}".`,
    {
      document: {
        id: ref.id,
        name: title,
        type,
        folder,
        content: type === DocumentType.Text ? content : ''
      }
    },
    [{ action: 'delete_document', args: { documentId: ref.id, confirmed: true } }]
  );
}

async function restoreDocument(call: AgentToolCall, ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const snapshot = call.args.snapshot as Record<string, unknown> | undefined;
  if (!snapshot) throw new Error('snapshot es requerido para restaurar');
  const explicitId = typeof call.args.documentId === 'string' ? call.args.documentId : undefined;
  const ref = explicitId ? adminDb.collection('documents').doc(explicitId) : adminDb.collection('documents').doc();
  const content = typeof snapshot.content === 'string' ? snapshot.content : '';
  const nextData = {
    ...snapshot,
    workspaceId: snapshot.workspaceId || ctx.workspaceId,
    ownerId: snapshot.ownerId || ctx.uid,
    updatedAt: FieldValue.serverTimestamp(),
    restoredBy: ctx.uid
  };
  await ref.set(nextData, { merge: true });
  if ((snapshot.type as string | undefined) !== DocumentType.Folder) {
    await syncTextDocumentToStorage({
      id: ref.id,
      name: typeof snapshot.name === 'string' ? snapshot.name : 'Documento restaurado',
      content,
      type: typeof snapshot.type === 'string' ? snapshot.type : DocumentType.Text,
      folder: typeof snapshot.folder === 'string' ? snapshot.folder : undefined,
      workspaceId: typeof snapshot.workspaceId === 'string' ? snapshot.workspaceId : ctx.workspaceId,
      ownerId: typeof snapshot.ownerId === 'string' ? snapshot.ownerId : ctx.uid,
      mimeType: typeof snapshot.mimeType === 'string' ? snapshot.mimeType : 'text/markdown',
      storagePath: typeof snapshot.storagePath === 'string' ? snapshot.storagePath : undefined
    }, content, {
      docRef: ref,
      source: 'agent-restore',
      writerId: ctx.uid,
      extraUpdate: { restoredBy: ctx.uid }
    });
  }
  return ok(call, `Restauré "${String(snapshot.name || ref.id)}".`, { documentId: ref.id });
}

async function updateDocument(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);
  const hydratedPrevious = await loadDocumentFullContent(doc);
  const previousSnapshot = {
    name: doc.name || 'Sin título',
    content: hydratedPrevious.content,
    folder: normalizeFolderPath(doc.folder),
    type: doc.type || DocumentType.Text,
    workspaceId: doc.workspaceId || ctx.workspaceId,
    ownerId: doc.ownerId || ctx.uid,
    mimeType: doc.mimeType || 'text/markdown',
    storagePath: doc.storagePath || null
  };

  const title = typeof call.args.title === 'string' ? call.args.title.trim() : doc.name || 'Sin título';
  const content = typeof call.args.content === 'string' ? call.args.content : hydratedPrevious.content;
  const docRef = adminDb.collection('documents').doc(doc.id);
  const docVersionField = (doc as unknown as { version?: unknown }).version;
  const baseVersion = typeof docVersionField === 'number' ? docVersionField : 0;
  await syncTextDocumentToStorage({
    ...doc,
    name: title,
    content,
    ownerId: doc.ownerId || ctx.uid,
    workspaceId: doc.workspaceId || ctx.workspaceId,
    mimeType: doc.mimeType || 'text/markdown'
  }, content, {
    docRef,
    source: 'agent-update',
    writerId: ctx.uid,
    baseVersion,
    extraUpdate: { name: title, lastUpdatedBy: ctx.uid }
  });

  return ok(call, `Actualicé "${title}".`, {
    document: {
      id: doc.id,
      name: title,
      previousPreview: excerpt(previousSnapshot.content),
      preview: excerpt(content)
    }
  }, [{ action: 'restore_document', args: { documentId: doc.id, snapshot: previousSnapshot } }]);
}

async function renameDocument(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  const newTitle = String(call.args.newTitle || '').trim();
  if (!documentId || !newTitle) throw new Error('documentId y newTitle son requeridos');
  const doc = await fetchDocumentForUser(documentId, ctx);
  await adminDb.collection('documents').doc(doc.id).update({
    name: newTitle,
    updatedAt: FieldValue.serverTimestamp(),
    lastUpdatedBy: ctx.uid
  });

  return ok(call, `Renombré "${doc.name || 'Sin título'}" a "${newTitle}".`, {
    document: { id: doc.id, previousName: doc.name || 'Sin título', name: newTitle }
  }, [{ action: 'rename_document', args: { documentId: doc.id, newTitle: doc.name || 'Sin título' } }]);
}

async function moveDocument(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  const targetFolder = normalizeFolderPath(String(call.args.targetFolder || '').trim());
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);
  const previousFolder = normalizeFolderPath(doc.folder);
  await adminDb.collection('documents').doc(doc.id).update({
    folder: targetFolder,
    updatedAt: FieldValue.serverTimestamp(),
    lastUpdatedBy: ctx.uid
  });
  return ok(call, `Moví "${doc.name || 'Sin título'}" a "${targetFolder}".`, {
    document: {
      id: doc.id,
      name: doc.name || 'Sin título',
      previousFolder,
      folder: targetFolder
    }
  }, [{ action: 'move_document', args: { documentId: doc.id, targetFolder: previousFolder } }]);
}

async function deleteDocument(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  const confirmed = call.args.confirmed === true;
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);

  if (!confirmed) {
    return confirm(call, `¿Confirmas eliminar "${doc.name || 'Sin título'}"?`, {
      document: { id: doc.id, name: doc.name || 'Sin título', folder: normalizeFolderPath(doc.folder) }
    });
  }

  // Hidratar contenido real para snapshot de restore_document.
  const hydratedSnapshot = await loadDocumentFullContent(doc);
  const snapshot = {
    name: doc.name || 'Sin título',
    content: hydratedSnapshot.content,
    folder: normalizeFolderPath(doc.folder),
    type: doc.type || DocumentType.Text,
    workspaceId: doc.workspaceId || ctx.workspaceId,
    ownerId: doc.ownerId || ctx.uid,
    mimeType: doc.mimeType || 'text/markdown',
    storagePath: doc.storagePath || null,
    size: doc.size || null,
    order: doc.order || null,
    url: doc.url || null
  };

  await adminDb.collection('documents').doc(doc.id).delete();
  await maybeDeleteStorageObject(doc.storagePath, doc.id);
  invalidateAgoraWorkspaceContext(doc.workspaceId || ctx.workspaceId);

  return ok(call, `Eliminé "${doc.name || 'Sin título'}".`, {
    document: { id: doc.id, name: doc.name || 'Sin título' }
  }, [{ action: 'restore_document', args: { documentId: doc.id, snapshot } }]);
}

async function searchDocuments(call: AgentToolCall, ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const queryText = String(call.args.query || '').trim().toLowerCase();
  if (!queryText) throw new Error('query es requerido');
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 10, 1, 25);
  const pageSize = resolvePageSize(call.args.pageSize, DEFAULT_PAGE_SIZE);
  const cursorParam = typeof call.args.cursor === 'string' ? call.args.cursor : null;
  const cursor = decodeDocumentPageCursor(cursorParam);

  let query: FirebaseFirestore.Query = adminDb.collection('documents');
  if (isPersonalWorkspaceId(ctx.workspaceId)) {
    query = query.where('ownerId', '==', ctx.uid);
    query = query.where('workspaceId', '==', PERSONAL_WORKSPACE_ID);
  } else {
    query = query.where('workspaceId', '==', ctx.workspaceId);
  }

  let snap: FirebaseFirestore.QuerySnapshot;
  let orderedByUpdatedAt = true;
  try {
    let q = query.orderBy('updatedAt', 'desc').orderBy('__name__', 'asc');
    if (cursor) {
      q = q.startAfter(Timestamp.fromMillis(cursor.updatedAtMs), cursor.id);
    }
    snap = await q.limit(pageSize).get();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const msg = (err as { message?: unknown }).message;
    const indexErr = code === 9 || code === 'failed-precondition'
      || (typeof msg === 'string' && /requires an index/i.test(msg));
    if (indexErr) {
      console.warn('[search_documents] missing composite index, fallback sin orderBy.');
      orderedByUpdatedAt = false;
      snap = await query.limit(pageSize).get();
    } else {
      throw err;
    }
  }
  let nextCursor: string | null = null;
  if (orderedByUpdatedAt && snap.size >= pageSize && snap.docs.length > 0) {
    const last = snap.docs[snap.docs.length - 1];
    if (last) {
      const rawUpdated = (last.data() as { updatedAt?: unknown }).updatedAt;
      const ms = toEpoch(rawUpdated);
      if (ms > 0) nextCursor = encodeDocumentPageCursor({ updatedAtMs: ms, id: last.id });
    }
  }
  const pageMeta = buildPageMeta(snap.size, nextCursor);

  // Tokenize query: each word must appear somewhere in the document (AND logic)
  const queryTokens = queryText.split(/\s+/).filter(t => t.length >= 2);
  if (queryTokens.length === 0) throw new Error('query demasiado corta');

  // Para docs con storagePath, Firestore `content` viene `FieldValue.delete()`d
  // tras escribir a MinIO. El blob real de búsqueda vive en `searchableContent`
  // (denormalizado por writeDocumentBlob/createDocumentBlob, ~4KB stripped MD).
  // Sin esto, search_documents devolvía 0 sobre workspaces con docs grandes.
  const buildHaystack = (doc: StoredDocument): string => {
    const body = doc.searchableContent || doc.content || '';
    return [doc.name, doc.folder, body].map(part => String(part || '').toLowerCase()).join('\n');
  };

  const previewSource = (doc: StoredDocument): string =>
    doc.searchableContent || doc.content || '';

  const results = snap.docs
    .map(doc => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) } as StoredDocument))
    .filter(doc => {
      const haystack = buildHaystack(doc);
      return queryTokens.every(token => haystack.includes(token));
    })
    .slice(0, limit)
    .map(doc => ({
      id: doc.id,
      name: doc.name || 'Sin título',
      folder: normalizeFolderPath(doc.folder),
      type: doc.type || DocumentType.Text,
      preview: excerpt(previewSource(doc), 180)
    }));

  const continuationNote = pageMeta.hasMore ? ` (página de ${pageMeta.scannedThisPage} doc(s); itera con cursor para más)` : '';

  // If AND match found nothing, try OR match (any token)
  if (results.length === 0) {
    const orResults = snap.docs
      .map(doc => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) } as StoredDocument))
      .map(doc => {
        const haystack = buildHaystack(doc);
        const matchCount = queryTokens.filter(token => haystack.includes(token)).length;
        return { doc, matchCount };
      })
      .filter(({ matchCount }) => matchCount > 0)
      .sort((a, b) => b.matchCount - a.matchCount)
      .slice(0, limit)
      .map(({ doc }) => ({
        id: doc.id,
        name: doc.name || 'Sin título',
        folder: normalizeFolderPath(doc.folder),
        type: doc.type || DocumentType.Text,
        preview: excerpt(previewSource(doc), 180)
      }));
    return ok(call, `La búsqueda devolvió ${orResults.length} resultado(s) (coincidencia parcial)${continuationNote}.`, { results: orResults, page: pageMeta });
  }

  return ok(call, `La búsqueda devolvió ${results.length} resultado(s)${continuationNote}.`, { results, page: pageMeta });
}

async function listFolders(call: AgentToolCall, ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const pageSize = resolvePageSize(call.args.pageSize, DEFAULT_PAGE_SIZE);
  const cursor = typeof call.args.cursor === 'string' ? call.args.cursor : null;
  const page = await loadWorkspaceDocumentsPage(ctx, { limit: pageSize, cursor });
  const { folders, emptyFolders, folderDocCountMap } = collectWorkspaceFolders(page.documents);
  const pageMeta = buildPageMeta(page.scannedThisPage, page.nextCursor);
  const continuationNote = pageMeta.hasMore ? ' (página parcial; itera con cursor si necesitas escanear todo el workspace para contar carpetas)' : '';

  return ok(
    call,
    `Encontré ${folders.length} carpeta(s) (${emptyFolders.length} vacía${emptyFolders.length === 1 ? '' : 's'})${continuationNote}.`,
    { folders, emptyFolders, folderDocCountMap, page: pageMeta }
  );
}

async function duplicateDocument(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  const newName = typeof call.args.newName === 'string' ? call.args.newName.trim() : '';
  const targetFolder = typeof call.args.targetFolder === 'string' ? normalizeFolderPath(call.args.targetFolder) : undefined;
  if (!documentId) throw new Error('documentId es requerido');
  const original = await fetchDocumentForUser(documentId, ctx);
  const hydrated = await loadDocumentFullContent(original);
  const cloneTitle = newName || `${original.name || 'Sin título'} (copia)`;
  return createDocument({
    ...call,
    args: {
      title: cloneTitle,
      content: hydrated.content,
      folder: targetFolder ?? normalizeFolderPath(original.folder),
      type: original.type || DocumentType.Text
    }
  }, ctx);
}

async function getStorageUsage(call: AgentToolCall, ctx: AgentExecutionContext) {
  const pageSize = resolvePageSize(call.args.pageSize, DEFAULT_PAGE_SIZE);
  const cursor = typeof call.args.cursor === 'string' ? call.args.cursor : null;
  const page = await loadWorkspaceDocumentsPage(ctx, { limit: pageSize, cursor });
  let totalBytes = 0;
  let textBytes = 0;
  let blobBytes = 0;
  let count = 0;
  for (const doc of page.documents) {
    if ((doc.type ?? DocumentType.Text) === DocumentType.Folder) continue;
    count += 1;
    const size = typeof doc.size === 'number' ? doc.size : (doc.content || '').length;
    totalBytes += size;
    if (doc.storagePath) blobBytes += size; else textBytes += size;
  }
  const pageMeta = buildPageMeta(page.scannedThisPage, page.nextCursor);
  const continuationNote = pageMeta.hasMore ? ' (página parcial; itera con cursor para contar todo el workspace)' : '';
  return ok(call, `Storage (página): ${count} doc(s), ${(totalBytes / 1024).toFixed(1)} KB total (${(blobBytes / 1024).toFixed(1)} KB en MinIO, ${(textBytes / 1024).toFixed(1)} KB en Firestore cache)${continuationNote}.`, {
    workspaceId: ctx.workspaceId,
    documentCount: count,
    totalBytes,
    minioBytes: blobBytes,
    firestoreBytes: textBytes,
    page: pageMeta
  });
}

async function findLargeDocuments(call: AgentToolCall, ctx: AgentExecutionContext) {
  const minBytes = typeof call.args.minBytes === 'number' ? call.args.minBytes : 100_000;
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 20, 1, 50);
  const pageSize = resolvePageSize(call.args.pageSize, DEFAULT_PAGE_SIZE);
  const cursor = typeof call.args.cursor === 'string' ? call.args.cursor : null;
  const page = await loadWorkspaceDocumentsPage(ctx, { limit: pageSize, cursor });
  const candidates = page.documents
    .filter(d => (d.type ?? DocumentType.Text) !== DocumentType.Folder)
    .map(d => ({
      id: d.id,
      name: d.name || 'Sin título',
      folder: normalizeFolderPath(d.folder),
      bytes: typeof d.size === 'number' ? d.size : (d.content || '').length,
      mimeType: d.mimeType || null,
      hasStorage: Boolean(d.storagePath)
    }))
    .filter(d => d.bytes >= minBytes)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
  const pageMeta = buildPageMeta(page.scannedThisPage, page.nextCursor);
  const continuationNote = pageMeta.hasMore ? ' (página parcial; itera con cursor para escanear todo el workspace)' : '';
  return ok(call, `${candidates.length} documento(s) ≥ ${minBytes} bytes${continuationNote}.`, { documents: candidates, minBytes, page: pageMeta });
}

async function listRecentActivity(call: AgentToolCall, ctx: AgentExecutionContext) {
  const sinceHours = clamp(typeof call.args.sinceHours === 'number' ? call.args.sinceHours : 24, 1, 720);
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 20, 1, 50);
  const sinceMs = Date.now() - sinceHours * 3600 * 1000;
  const pageSize = resolvePageSize(call.args.pageSize, DEFAULT_PAGE_SIZE);
  const cursor = typeof call.args.cursor === 'string' ? call.args.cursor : null;
  const page = await loadWorkspaceDocumentsPage(ctx, { limit: pageSize, cursor });
  const docs = page.documents;
  const recent = docs
    .filter(d => (d.type ?? DocumentType.Text) !== DocumentType.Folder)
    .map(d => ({ doc: d, ts: toEpoch(d.updatedAt) }))
    .filter(({ ts }) => ts >= sinceMs)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map(({ doc, ts }) => ({
      id: doc.id,
      name: doc.name || 'Sin título',
      folder: normalizeFolderPath(doc.folder),
      updatedAtMs: ts,
      updatedAtIso: ts > 0 ? new Date(ts).toISOString() : null
    }));
  return ok(call, `${recent.length} documento(s) editados en las últimas ${sinceHours}h.`, { documents: recent, sinceHours });
}

async function listFavorites(call: AgentToolCall, ctx: AgentExecutionContext) {
  const userSnap = await adminDb.collection('users').doc(ctx.uid).get();
  const data = userSnap.data() as Record<string, unknown> | undefined;
  const favoritesByWorkspace = data?.favoritesByWorkspace as Record<string, string[]> | undefined;
  const favoriteIds = Array.isArray(favoritesByWorkspace?.[ctx.workspaceId])
    ? favoritesByWorkspace![ctx.workspaceId]!
    : [];
  if (favoriteIds.length === 0) {
    return ok(call, 'No hay favoritos en este workspace.', { favorites: [] });
  }
  // Favoritos: resuelvo cada uno por ID directo en vez de scan completo.
  // Esto escala correctamente a workspaces de N>>5000 docs.
  const favorites: Array<{ id: string; name: string; folder: string }> = [];
  await Promise.all(favoriteIds.map(async (id) => {
    const snap = await adminDb.collection('documents').doc(id).get();
    if (!snap.exists) return;
    const data = snap.data() as Record<string, unknown>;
    favorites.push({
      id: snap.id,
      name: (typeof data.name === 'string' ? data.name : '') || 'Sin título',
      folder: normalizeFolderPath(typeof data.folder === 'string' ? data.folder : undefined)
    });
  }));
  return ok(call, `${favorites.length} favorito(s) en este workspace.`, { favorites });
}

async function addFavorite(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);
  await adminDb.collection('users').doc(ctx.uid).set({
    favoritesByWorkspace: { [ctx.workspaceId]: FieldValue.arrayUnion(doc.id) }
  }, { merge: true });
  return ok(call, `Añadido "${doc.name || 'Sin título'}" a favoritos.`, { documentId: doc.id }, [
    { action: 'remove_favorite', args: { documentId: doc.id } }
  ]);
}

async function removeFavorite(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  await adminDb.collection('users').doc(ctx.uid).set({
    favoritesByWorkspace: { [ctx.workspaceId]: FieldValue.arrayRemove(documentId) }
  }, { merge: true });
  return ok(call, `Removido ${documentId} de favoritos.`, { documentId }, [
    { action: 'add_favorite', args: { documentId } }
  ]);
}

interface LintFinding {
  ruleId: string;
  severity: 'error' | 'warning' | 'info';
  line: number;
  message: string;
}

function lintMarkdownContent(content: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = content.split('\n');
  let inFence = false;
  let fenceMarker = '';
  let prevHeading = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fenceMatch = line.match(/^(```|~~~)/);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      if (!inFence) { inFence = true; fenceMarker = marker; prevHeading = false; continue; }
      if (line.startsWith(fenceMarker)) { inFence = false; fenceMarker = ''; prevHeading = false; continue; }
    }
    if (inFence) { prevHeading = false; continue; }
    if (line.length > 220) findings.push({ ruleId: 'line-too-long', severity: 'info', line: i + 1, message: `Línea de ${line.length} caracteres (>220)` });
    if (/[ \t]+$/.test(line)) findings.push({ ruleId: 'trailing-whitespace', severity: 'info', line: i + 1, message: 'Espacio en blanco al final' });
    if (/^\t+/.test(line) && /^ +/.test(lines[i - 1] ?? '')) findings.push({ ruleId: 'mixed-indent', severity: 'warning', line: i + 1, message: 'Indent mezclado tabs/espacios' });
    const hMatch = line.match(/^(#{1,6})\s*$/);
    if (hMatch) findings.push({ ruleId: 'heading-empty', severity: 'warning', line: i + 1, message: 'Heading sin texto' });
    const hWithText = line.match(/^(#{1,6})\s+(.+)$/);
    if (hWithText) {
      if (prevHeading) findings.push({ ruleId: 'consecutive-headings', severity: 'info', line: i + 1, message: 'Heading directamente después de otro heading (sin contenido entre medio)' });
      prevHeading = true;
    } else if (line.trim()) {
      prevHeading = false;
    }
    if (/^[-*+]\s*\[\s\]/.test(line)) {
      // todo no terminado, OK
    }
  }
  if (content.length > 0 && !content.endsWith('\n')) {
    findings.push({ ruleId: 'no-trailing-newline', severity: 'info', line: lines.length, message: 'Archivo sin newline final' });
  }
  return findings;
}

async function lintDocumentTool(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);
  const hydrated = await loadDocumentFullContent(doc);
  const findings = lintMarkdownContent(hydrated.content);
  const counts = findings.reduce<Record<string, number>>((acc, f) => { acc[f.severity] = (acc[f.severity] ?? 0) + 1; return acc; }, {});
  return ok(call, `Lint "${doc.name || 'Sin título'}": ${findings.length} hallazgo(s) (${counts.error || 0} error, ${counts.warning || 0} warning, ${counts.info || 0} info).`, {
    document: { id: doc.id, name: doc.name || 'Sin título' },
    findings,
    counts,
    note: 'Linter ligero del agente (~7 reglas regex). Para las 53 reglas completas usa el panel Problemas (open_app_panel problems) que corre el linter del cliente.'
  });
}

async function getWorkspaceInfo(call: AgentToolCall, ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const workspace = await fetchWorkspaceDoc(ctx.workspaceId, ctx.uid);
  const members = Array.isArray(workspace.members) ? workspace.members : [ctx.uid];
  return ok(call, 'Recuperé la información del workspace.', {
    workspace: {
      id: String(workspace.id),
      name: String(workspace.name || 'Workspace'),
      ownerId: String(workspace.ownerId || ctx.uid),
      type: String(workspace.type || 'shared'),
      members,
      membersCount: members.length,
      pendingInvites: Array.isArray(workspace.pendingInvites) ? workspace.pendingInvites : []
    }
  });
}

async function createFolder(call: AgentToolCall, ctx: AgentExecutionContext) {
  const name = String(call.args.name || '').trim();
  if (!name) throw new Error('name es requerido');
  const parentFolder = typeof call.args.parentFolder === 'string' ? normalizeFolderPath(call.args.parentFolder) : undefined;
  const folderPath = parentFolder ? normalizeFolderPath(`${parentFolder}/${name}`) : normalizeFolderPath(name);
  return createDocument({
    ...call,
    args: {
      title: name,
      type: DocumentType.Folder,
      folder: folderPath,
      content: ''
    }
  }, ctx);
}

/**
 * Itera TODAS las páginas del workspace acumulando los documentos.
 * Solo usar en operaciones que NECESITAN ver todo el workspace (rename/delete
 * de carpeta cascada). El resto debería paginar y devolver `nextCursor`.
 */
async function loadAllWorkspaceDocuments(ctx: AgentExecutionContext): Promise<StoredDocument[]> {
  const all: StoredDocument[] = [];
  let cursor: string | null = null;
  let more = true;
  while (more) {
    const page = await loadWorkspaceDocumentsPage(ctx, { limit: DEFAULT_PAGE_SIZE, cursor });
    all.push(...page.documents);
    if (!page.nextCursor) {
      more = false;
    } else {
      cursor = page.nextCursor;
    }
  }
  return all;
}

async function renameFolder(call: AgentToolCall, ctx: AgentExecutionContext) {
  const fromPath = normalizeFolderPath(String(call.args.fromPath || '').trim());
  const toName = String(call.args.toName || '').trim();
  if (!fromPath || !toName) throw new Error('fromPath y toName son requeridos');
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);

  const documents = await loadAllWorkspaceDocuments(ctx);
  const folderDocs = documents.filter(d =>
    d.type === DocumentType.Folder &&
    normalizeFolderPath(`${d.folder ?? ''}${d.folder ? '/' : ''}${d.name ?? ''}`) === fromPath
  );
  const childDocs = documents.filter(d =>
    d.type !== DocumentType.Folder && (
      normalizeFolderPath(d.folder) === fromPath ||
      normalizeFolderPath(d.folder).startsWith(`${fromPath}/`)
    )
  );

  const parts = fromPath.split('/');
  parts[parts.length - 1] = toName;
  const newPath = normalizeFolderPath(parts.join('/'));

  const batch = adminDb.batch();
  for (const fdoc of folderDocs) {
    batch.update(adminDb.collection('documents').doc(fdoc.id), {
      name: toName,
      updatedAt: FieldValue.serverTimestamp(),
      lastUpdatedBy: ctx.uid
    });
  }
  for (const child of childDocs) {
    const oldFolder = normalizeFolderPath(child.folder);
    const newFolder = oldFolder === fromPath ? newPath : `${newPath}${oldFolder.slice(fromPath.length)}`;
    batch.update(adminDb.collection('documents').doc(child.id), {
      folder: newFolder,
      updatedAt: FieldValue.serverTimestamp(),
      lastUpdatedBy: ctx.uid
    });
  }
  await batch.commit();

  return ok(call, `Renombré la carpeta "${fromPath}" → "${newPath}" (${childDocs.length} documento(s) movido(s)).`, {
    fromPath, toPath: newPath, foldersUpdated: folderDocs.length, documentsUpdated: childDocs.length
  }, [{ action: 'rename_folder', args: { fromPath: newPath, toName: parts[parts.length - 2] || fromPath } }]);
}

async function deleteFolder(call: AgentToolCall, ctx: AgentExecutionContext) {
  const folderPath = normalizeFolderPath(String(call.args.folderPath || '').trim());
  const confirmed = call.args.confirmed === true;
  const cascade = call.args.cascade === true;
  if (!folderPath) throw new Error('folderPath es requerido');
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);

  const documents = await loadAllWorkspaceDocuments(ctx);
  const folderDocs = documents.filter(d =>
    d.type === DocumentType.Folder &&
    normalizeFolderPath(`${d.folder ?? ''}${d.folder ? '/' : ''}${d.name ?? ''}`) === folderPath
  );
  const childDocs = documents.filter(d =>
    d.type !== DocumentType.Folder && (
      normalizeFolderPath(d.folder) === folderPath ||
      normalizeFolderPath(d.folder).startsWith(`${folderPath}/`)
    )
  );

  if (childDocs.length > 0 && !cascade) {
    return fail(call, new Error(`La carpeta "${folderPath}" tiene ${childDocs.length} documento(s). Pasa cascade:true para borrarlos también o muévelos antes.`));
  }

  if (!confirmed) {
    return confirm(call, `¿Confirmas eliminar la carpeta "${folderPath}"${cascade ? ` y sus ${childDocs.length} documento(s) hijos` : ''}?`, {
      folderPath, cascade, foldersToDelete: folderDocs.length, documentsToDelete: cascade ? childDocs.length : 0
    });
  }

  const batch = adminDb.batch();
  for (const fdoc of folderDocs) batch.delete(adminDb.collection('documents').doc(fdoc.id));
  if (cascade) {
    for (const child of childDocs) batch.delete(adminDb.collection('documents').doc(child.id));
  }
  await batch.commit();

  if (cascade) {
    void Promise.all(childDocs.map(c => maybeDeleteStorageObject(c.storagePath, c.id))).catch(() => undefined);
  }
  invalidateAgoraWorkspaceContext(ctx.workspaceId);

  return ok(call, `Eliminé la carpeta "${folderPath}"${cascade ? ` y ${childDocs.length} documento(s)` : ''}.`, {
    folderPath, foldersDeleted: folderDocs.length, documentsDeleted: cascade ? childDocs.length : 0
  });
}

async function listAccessibleWorkspaces(call: AgentToolCall, ctx: AgentExecutionContext) {
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 25, 1, 100);
  const snap = await adminDb.collection('workspaces')
    .where('members', 'array-contains', ctx.uid)
    .limit(limit)
    .get();
  const workspaces = snap.docs.map(d => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      name: typeof data.name === 'string' ? data.name : 'Workspace',
      ownerId: typeof data.ownerId === 'string' ? data.ownerId : null,
      type: typeof data.type === 'string' ? data.type : 'shared',
      membersCount: Array.isArray(data.members) ? (data.members as unknown[]).length : 0,
      isCurrent: d.id === ctx.workspaceId
    };
  });
  return ok(call, `Tienes acceso a ${workspaces.length} workspace(s) compartido(s) (sin contar el personal).`, { workspaces });
}

async function getDocumentContentAtRevision(call: AgentToolCall, _ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  const revision = String(call.args.revision || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  return ok(call, `Las revisiones por documento aún no están persistidas en Firestore. Usa git_log + git_show del worker como historial real, o read_document para la versión actual.`, {
    documentId, revision: revision || null,
    notImplemented: true,
    suggestion: 'usa git_log y los archivos en /workspace del worker'
  });
}

async function uploadExternalUrl(call: AgentToolCall, ctx: AgentExecutionContext) {
  const url = String(call.args.url || '').trim();
  const targetFolder = normalizeFolderPath(String(call.args.targetFolder || '').trim());
  const customName = typeof call.args.name === 'string' ? call.args.name.trim() : '';
  const confirmed = call.args.confirmed === true;
  if (!url) throw new Error('url es requerida');
  if (!confirmed) {
    return confirm(call, `¿Descargar "${url}" e ingestar como documento en "${targetFolder || '(raíz)'}"?`, {
      url, targetFolder
    });
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`URL inválida: ${url}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Sólo http/https');
  const blockedHost = /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[0-1])\.|localhost$|0\.0\.0\.0$)/.test(parsed.hostname.toLowerCase());
  if (blockedHost) throw new Error(`Host privado bloqueado: ${parsed.hostname}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'agora-agent/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} al descargar`);
    const text = await res.text();
    const truncated = text.slice(0, 2_000_000);
    const guessedName = customName
      || parsed.pathname.split('/').filter(Boolean).pop()
      || `download-${Date.now()}.txt`;
    const result = await createDocument({
      ...call,
      args: { title: guessedName, content: truncated, folder: targetFolder, type: DocumentType.Text }
    }, ctx);
    return ok(call, `Descargué ${truncated.length} bytes de ${parsed.host} y los ingresé como "${guessedName}".`, {
      url, name: guessedName, bytesIngested: truncated.length, document: result.data
    });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadWorkspaceBundle(call: AgentToolCall, ctx: AgentExecutionContext) {
  const folderPath = typeof call.args.folderPath === 'string' ? normalizeFolderPath(call.args.folderPath) : undefined;
  const pageSize = resolvePageSize(call.args.pageSize, DEFAULT_PAGE_SIZE);
  const cursor = typeof call.args.cursor === 'string' ? call.args.cursor : null;
  const page = await loadWorkspaceDocumentsPage(ctx, { limit: pageSize, cursor });
  const documents = page.documents;
  const filtered = folderPath
    ? documents.filter(d => normalizeFolderPath(d.folder) === folderPath || normalizeFolderPath(d.folder).startsWith(`${folderPath}/`))
    : documents;
  const textDocs = filtered.filter(d => (d.type || DocumentType.Text) !== DocumentType.Folder);
  const manifest = textDocs.map(d => ({
    id: d.id,
    name: d.name || 'Sin título',
    folder: normalizeFolderPath(d.folder),
    type: String(d.type ?? DocumentType.Text),
    storagePath: d.storagePath ?? null,
    size: typeof d.size === 'number' ? d.size : (d.content?.length ?? 0),
    updatedAt: formatTimestamp(d.updatedAt)
  }));
  const pageMeta = buildPageMeta(page.scannedThisPage, page.nextCursor);
  const continuationNote = pageMeta.hasMore ? ' (página parcial; itera con cursor para construir el manifiesto completo)' : '';
  return ok(call, `Manifiesto de ${manifest.length} documento(s)${folderPath ? ` bajo "${folderPath}"` : ''}${continuationNote}. Para zip real usa el flujo del frontend (Exportar) — el agente expone solo el manifiesto.`, {
    workspaceId: ctx.workspaceId,
    folderPath: folderPath || null,
    documentCount: manifest.length,
    manifest: manifest.slice(0, 200),
    page: pageMeta,
    notImplementedFully: true,
    suggestion: 'Para zip binario el cliente debe llamar a /api/workspaces/:id/export'
  });
}

export const DOCUMENT_TOOL_HANDLERS: Record<string, ToolHandler> = {
  list_documents: listDocuments,
  list_files: listDocuments,
  read_document: readDocument,
  read_file: readDocument,
  create_document: createDocument,
  create_file: createDocument,
  update_document: updateDocument,
  restore_document: restoreDocument,
  rename_document: renameDocument,
  rename_file: renameDocument,
  move_document: moveDocument,
  delete_document: deleteDocument,
  delete_file: deleteDocument,
  search_documents: searchDocuments,
  list_folders: listFolders,
  create_folder: createFolder,
  rename_folder: renameFolder,
  delete_folder: deleteFolder,
  list_workspaces: listAccessibleWorkspaces,
  get_document_content_at_revision: getDocumentContentAtRevision,
  upload_external_url: uploadExternalUrl,
  download_workspace_bundle: downloadWorkspaceBundle,
  duplicate_document: duplicateDocument,
  get_storage_usage: getStorageUsage,
  find_large_documents: findLargeDocuments,
  list_recent_workspace_activity: listRecentActivity,
  list_favorites: listFavorites,
  add_favorite: addFavorite,
  remove_favorite: removeFavorite,
  lint_document: lintDocumentTool,
  get_workspace_info: getWorkspaceInfo,
  inspect_workspace: inspectWorkspace,
  search_workspace: searchWorkspace,
  read_workspace_bundle: readWorkspaceBundle
};
