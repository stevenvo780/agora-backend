import { adminDb } from '@/lib/firebase-admin';

export async function buildAgoraWorkspaceContext(workspaceId: string): Promise<string> {
  const parts: string[] = [];

  // Run both Firestore queries in parallel to halve latency
  const [docsResult, semResult] = await Promise.allSettled([
    adminDb.collection('documents').where('workspaceId', '==', workspaceId).limit(30).get(),
    adminDb.collection('workspaceSemanticStates').doc(workspaceId).get()
  ]);

  try {
    const docsSnap = docsResult.status === 'fulfilled' ? docsResult.value : null;
    if (docsSnap && !docsSnap.empty) {
      type FireDoc = { id: string } & Record<string, unknown>;
      const textDocs = docsSnap.docs
        .map(d => ({ id: d.id, ...d.data() }) as FireDoc)
        .filter(d => d.type === 'text');

      // Extract folder names from documents
      const folderNames = new Set<string>();
      docsSnap.docs.forEach(d => {
        const data = d.data() as Record<string, unknown>;
        if (typeof data.folder === 'string' && data.folder) folderNames.add(data.folder);
        if (data.type === 'folder' && typeof data.name === 'string') folderNames.add(data.name);
      });

      if (folderNames.size > 0) {
        parts.push('## Carpetas del workspace');
        for (const folder of Array.from(folderNames).sort()) {
          parts.push(`- ${folder}`);
        }
        parts.push('');
      }

      if (textDocs.length > 0) {
        // Only include document titles (not content) to keep prompt short
        // and force the agent to use read_document for actual content
        parts.push('## Documentos disponibles en el workspace');
        parts.push('(Usa `read_document` para leer el contenido de cualquiera de estos documentos)\n');
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

  if (parts.length === 0) return '';
  return `# Contexto del workspace Agora\n\n${parts.join('\n')}`;
}
