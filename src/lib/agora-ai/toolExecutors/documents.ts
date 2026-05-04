
import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, confirm, clamp, excerpt, toEpoch, formatTimestamp, truncateText, containsQueryTokens,
  ensureWorkspaceAccess, fetchWorkspaceDoc, fetchDocumentForUser, loadWorkspaceDocuments,
  summarizeDocumentMeta, syncTextDocumentToStorage, maybeDeleteStorageObject,
  listWorkspaceSnippets, loadBoardStateIfExists, loadSemanticState,
  fetchWorkerStatus,
  normalizeFolderPath, adminDb, FieldValue,
  DocumentType, PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId,
  MAX_DOC_SCAN, DEFAULT_DOC_LIMIT,
  type StoredDocument, type StoredSnippet, type StoredBoardColumn, type StoredBoardCard
} from './shared';
import { EMPTY_SEMANTIC_WORKSPACE_STATE } from '@/lib/semantic/workspace-state';

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
  const includeWorker = call.args.includeWorker === true;
  const [workspace, documents, snippets, semantic, board, worker] = await Promise.all([
    fetchWorkspaceDoc(ctx.workspaceId, ctx.uid),
    loadWorkspaceDocuments(ctx, MAX_DOC_SCAN),
    listWorkspaceSnippets(ctx).catch(() => [] as StoredSnippet[]),
    loadSemanticState(ctx).catch(() => EMPTY_SEMANTIC_WORKSPACE_STATE),
    loadBoardStateIfExists(ctx).catch(() => ({ columns: [] as StoredBoardColumn[], cards: [] as StoredBoardCard[] })),
    includeWorker ? fetchWorkerStatus(ctx, 3000) : Promise.resolve(null)
  ]);

  const { folders, emptyFolders, folderDocCountMap } = collectWorkspaceFolders(documents);

  const textDocs = documents.filter((doc: StoredDocument) => (doc.type || DocumentType.Text) !== DocumentType.Folder);
  const folderDocs = documents.filter((doc: StoredDocument) => doc.type === DocumentType.Folder);
  const recentDocuments = documents
    .slice()
    .sort((left: StoredDocument, right: StoredDocument) => toEpoch(right.updatedAt) - toEpoch(left.updatedAt))
    .slice(0, limit)
    .map(summarizeDocumentMeta);

  return ok(call, `Inventarié el workspace: ${documents.length} documento(s), ${folders.length} carpeta(s) (${emptyFolders.length} vacía${emptyFolders.length === 1 ? '' : 's'}), ${snippets.length} snippet(s), ${semantic.concepts.length} concepto(s).`, {
    workspace: {
      id: String(workspace.id),
      name: String(workspace.name || 'Workspace'),
      type: String(workspace.type || (isPersonalWorkspaceId(ctx.workspaceId) ? 'personal' : 'shared')),
      membersCount: Array.isArray(workspace.members) ? workspace.members.length : 1
    },
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
  const [documents, snippets, semantic, board] = await Promise.all([
    loadWorkspaceDocuments(ctx, MAX_DOC_SCAN),
    listWorkspaceSnippets(ctx).catch(() => [] as StoredSnippet[]),
    loadSemanticState(ctx).catch(() => EMPTY_SEMANTIC_WORKSPACE_STATE),
    loadBoardStateIfExists(ctx).catch(() => ({ columns: [] as StoredBoardColumn[], cards: [] as StoredBoardCard[] }))
  ]);

  const documentResults = documents
    .filter((doc: StoredDocument) => containsQueryTokens([doc.name, doc.folder, doc.content].map(String).join('\n'), queryText))
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
  return ok(call, `La búsqueda global devolvió ${total} resultado(s).`, {
    query: queryText,
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

  let docs: StoredDocument[];
  if (documentIds.length > 0) {
    docs = await Promise.all(documentIds.slice(0, maxDocuments).map((id) => fetchDocumentForUser(id, ctx)));
  } else {
    docs = await loadWorkspaceDocuments(ctx, MAX_DOC_SCAN);
    if (folder) {
      docs = docs.filter((doc) => {
        const docFolder = normalizeFolderPath(doc.folder);
        return docFolder === folder || docFolder.startsWith(`${folder}/`);
      });
    }
    if (queryText) {
      docs = docs.filter((doc) => containsQueryTokens([doc.name, doc.folder, doc.content].map(String).join('\n'), queryText));
    }
    docs = docs
      .sort((left, right) => toEpoch(right.updatedAt) - toEpoch(left.updatedAt))
      .slice(0, maxDocuments);
  }

  const bundle: Record<string, unknown> = {
    documents: docs.map((doc) => ({
      ...summarizeDocumentMeta(doc),
      content: includeContent ? truncateText(doc.content || '', maxCharsPerDocument) : undefined,
      truncated: includeContent ? (doc.content || '').length > maxCharsPerDocument : undefined,
      mimeType: doc.mimeType || null
    }))
  };

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

  return ok(call, `Leí un paquete de contexto con ${docs.length} documento(s).`, {
    filters: { folder, query: queryText, documentIds },
    bundle
  });
}

async function listDocuments(call: AgentToolCall, ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const folder = typeof call.args.folder === 'string' && call.args.folder.trim()
    ? normalizeFolderPath(call.args.folder)
    : null;
  const type = typeof call.args.type === 'string' ? call.args.type : null;
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : DEFAULT_DOC_LIMIT, 1, 100);

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

  const snap = await query.limit(limit * 3).get();
  const allDocs = snap.docs
    .map(doc => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) } as StoredDocument));

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

  return ok(call, `Encontré ${documents.length} documento(s)${folder ? ` en "${folder}" (incluye subcarpetas)` : ''}.`, { documents });
}

async function readDocument(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);
  return ok(call, `Leí "${doc.name || 'Sin título'}".`, {
    document: {
      id: doc.id,
      name: doc.name || 'Sin título',
      type: doc.type || DocumentType.Text,
      folder: normalizeFolderPath(doc.folder),
      content: doc.content || '',
      preview: excerpt(doc.content || ''),
      mimeType: doc.mimeType || null
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
    content: type === DocumentType.Folder ? '' : content,
    mimeType: type === DocumentType.Folder ? null : 'text/markdown',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdBy: ctx.uid,
    lastUpdatedBy: ctx.uid
  };

  const ref = await adminDb.collection('documents').add(payload);
  const storagePath = type === DocumentType.Text
    ? await syncTextDocumentToStorage({
      id: ref.id,
      name: title,
      content,
      type,
      folder,
      workspaceId: ctx.workspaceId,
      ownerId: ctx.uid,
      mimeType: 'text/markdown'
    }, content)
    : null;

  if (storagePath) {
    await ref.update({ storagePath });
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
    }, content);
  }
  return ok(call, `Restauré "${String(snapshot.name || ref.id)}".`, { documentId: ref.id });
}

async function updateDocument(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);
  const previousSnapshot = {
    name: doc.name || 'Sin título',
    content: doc.content || '',
    folder: normalizeFolderPath(doc.folder),
    type: doc.type || DocumentType.Text,
    workspaceId: doc.workspaceId || ctx.workspaceId,
    ownerId: doc.ownerId || ctx.uid,
    mimeType: doc.mimeType || 'text/markdown',
    storagePath: doc.storagePath || null
  };

  const title = typeof call.args.title === 'string' ? call.args.title.trim() : doc.name || 'Sin título';
  const content = typeof call.args.content === 'string' ? call.args.content : doc.content || '';
  const updateData: Record<string, unknown> = {
    name: title,
    content,
    updatedAt: FieldValue.serverTimestamp(),
    lastUpdatedBy: ctx.uid
  };
  const storagePath = await syncTextDocumentToStorage({
    ...doc,
    name: title,
    content,
    ownerId: doc.ownerId || ctx.uid,
    workspaceId: doc.workspaceId || ctx.workspaceId,
    mimeType: doc.mimeType || 'text/markdown'
  }, content);
  if (storagePath) {
    updateData.storagePath = storagePath;
  }
  await adminDb.collection('documents').doc(doc.id).update(updateData);

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

  const snapshot = {
    name: doc.name || 'Sin título',
    content: doc.content || '',
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

  return ok(call, `Eliminé "${doc.name || 'Sin título'}".`, {
    document: { id: doc.id, name: doc.name || 'Sin título' }
  }, [{ action: 'restore_document', args: { documentId: doc.id, snapshot } }]);
}

async function searchDocuments(call: AgentToolCall, ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const queryText = String(call.args.query || '').trim().toLowerCase();
  if (!queryText) throw new Error('query es requerido');
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 10, 1, 25);

  let query: FirebaseFirestore.Query = adminDb.collection('documents');
  if (isPersonalWorkspaceId(ctx.workspaceId)) {
    query = query.where('ownerId', '==', ctx.uid);
    query = query.where('workspaceId', '==', PERSONAL_WORKSPACE_ID);
  } else {
    query = query.where('workspaceId', '==', ctx.workspaceId);
  }

  const snap = await query.limit(MAX_DOC_SCAN).get();

  // Tokenize query: each word must appear somewhere in the document (AND logic)
  const queryTokens = queryText.split(/\s+/).filter(t => t.length >= 2);
  if (queryTokens.length === 0) throw new Error('query demasiado corta');

  const results = snap.docs
    .map(doc => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) } as StoredDocument))
    .filter(doc => {
      const haystack = [doc.name, doc.folder, doc.content].map(part => String(part || '').toLowerCase()).join('\n');
      // Each token must appear in the haystack (AND match)
      return queryTokens.every(token => haystack.includes(token));
    })
    .slice(0, limit)
    .map(doc => ({
      id: doc.id,
      name: doc.name || 'Sin título',
      folder: normalizeFolderPath(doc.folder),
      type: doc.type || DocumentType.Text,
      preview: excerpt(doc.content || '', 180)
    }));

  // If AND match found nothing, try OR match (any token)
  if (results.length === 0) {
    const orResults = snap.docs
      .map(doc => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) } as StoredDocument))
      .map(doc => {
        const haystack = [doc.name, doc.folder, doc.content].map(part => String(part || '').toLowerCase()).join('\n');
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
        preview: excerpt(doc.content || '', 180)
      }));
    return ok(call, `La búsqueda devolvió ${orResults.length} resultado(s) (coincidencia parcial).`, { results: orResults });
  }

  return ok(call, `La búsqueda devolvió ${results.length} resultado(s).`, { results });
}

async function listFolders(call: AgentToolCall, ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const documents = await loadWorkspaceDocuments(ctx, MAX_DOC_SCAN);
  const { folders, emptyFolders, folderDocCountMap } = collectWorkspaceFolders(documents);

  return ok(
    call,
    `Encontré ${folders.length} carpeta(s) (${emptyFolders.length} vacía${emptyFolders.length === 1 ? '' : 's'}).`,
    { folders, emptyFolders, folderDocCountMap }
  );
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
  get_workspace_info: getWorkspaceInfo,
  inspect_workspace: inspectWorkspace,
  search_workspace: searchWorkspace,
  read_workspace_bundle: readWorkspaceBundle
};
