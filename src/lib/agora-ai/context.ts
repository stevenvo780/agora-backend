import { adminDb } from '@/lib/firebase-admin';

const AGENT_DOC_LIMIT = 200;
const CONTEXT_TTL_MS = 60_000;

type CachedContext = { value: string; expiresAt: number };
const contextCache = new Map<string, CachedContext>();

const FAILED_PRECONDITION = 9 as const;

const isFirestoreIndexError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === FAILED_PRECONDITION || code === 'failed-precondition') return true;
  const msg = (error as { message?: unknown }).message;
  return typeof msg === 'string' && /requires an index/i.test(msg);
};

const fetchDocsSnapshot = async (workspaceId: string): Promise<FirebaseFirestore.QuerySnapshot | null> => {
  const base = adminDb.collection('documents').where('workspaceId', '==', workspaceId);
  try {
    return await base.orderBy('updatedAt', 'desc').limit(AGENT_DOC_LIMIT).get();
  } catch (err) {
    if (isFirestoreIndexError(err)) {
      console.error(
        '[agora-ai/context] Composite index missing for workspaceId+updatedAt. ' +
        'Create it via:\n' +
        '  gcloud firestore indexes composite create \\\n' +
        '    --collection-group=documents \\\n' +
        '    --field-config=field-path=workspaceId,order=ascending \\\n' +
        '    --field-config=field-path=updatedAt,order=descending'
      );
      try {
        return await base.limit(AGENT_DOC_LIMIT).get();
      } catch {
        return null;
      }
    }
    return null;
  }
};

export async function buildAgoraWorkspaceContext(workspaceId: string): Promise<string> {
  // Cache server-side por workspaceId con TTL corto. Misma sesión del agente
  // tiende a reusar el contexto; sin cache cada turno re-pega 200 docs a
  // Firestore.
  const cached = contextCache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const parts: string[] = [];

  const [docsResult, semResult] = await Promise.allSettled([
    fetchDocsSnapshot(workspaceId),
    adminDb.collection('workspaceSemanticStates').doc(workspaceId).get()
  ]);

  try {
    const docsSnap = docsResult.status === 'fulfilled' ? docsResult.value : null;
    if (docsSnap && !docsSnap.empty) {
      type FireDoc = { id: string } & Record<string, unknown>;
      const allDocs = docsSnap.docs.map(d => ({ id: d.id, ...d.data() }) as FireDoc);
      const textDocs = allDocs.filter(d => d.type === 'text');

      const folderNames = new Set<string>();
      for (const d of allDocs) {
        if (typeof d.folder === 'string' && d.folder) folderNames.add(d.folder);
        if (d.type === 'folder' && typeof d.name === 'string') folderNames.add(d.name);
      }

      if (folderNames.size > 0) {
        parts.push('## Carpetas del workspace');
        for (const folder of Array.from(folderNames).sort()) {
          parts.push(`- ${folder}`);
        }
        parts.push('');
      }

      if (textDocs.length > 0) {
        parts.push(`## Documentos disponibles en el workspace (${textDocs.length}${docsSnap.size === AGENT_DOC_LIMIT ? `, mostrando los ${AGENT_DOC_LIMIT} más recientes` : ''})`);
        parts.push('(Usa `read_document` para leer el contenido. Filtra por carpeta o nombre antes.)\n');
        for (const doc of textDocs) {
          const folder = doc.folder ? ` [carpeta: ${String(doc.folder)}]` : '';
          parts.push(`- ${String(doc.name || 'Sin título')} (ID: ${doc.id})${folder}`);
        }
        parts.push('');
      }
    }
  } catch {
    // best-effort context
  }

  try {
    const semSnap = semResult.status === 'fulfilled' ? semResult.value : null;
    if (semSnap?.exists) {
      const sem = semSnap.data() as Record<string, unknown>;
      const concepts = (sem.concepts as Array<Record<string, unknown>> | undefined) ?? [];
      const fragments = (sem.fragments as Array<Record<string, unknown>> | undefined) ?? [];

      if (concepts.length > 0) {
        parts.push('\n## Conceptos semánticos del workspace\n');
        for (const concept of concepts.slice(0, 25)) {
          const def = String(concept.definition ?? concept.formula ?? '');
          parts.push(`- **${String(concept.title ?? '')}**${def ? `: ${def}` : ''}`);
        }
      }

      if (fragments.length > 0) {
        parts.push('\n## Fragmentos de texto marcados\n');
        for (const fragment of fragments.slice(0, 20)) {
          const text = String(fragment.text ?? '').slice(0, 250);
          parts.push(`- [${String(fragment.kind ?? '')}] "${text}"`);
        }
      }
    }
  } catch {
    // best-effort context
  }

  const value = parts.length === 0 ? '' : `# Contexto del workspace Agora\n\n${parts.join('\n')}`;
  contextCache.set(workspaceId, { value, expiresAt: Date.now() + CONTEXT_TTL_MS });
  return value;
}

export function invalidateAgoraWorkspaceContext(workspaceId?: string): void {
  if (workspaceId) contextCache.delete(workspaceId);
  else contextCache.clear();
}
