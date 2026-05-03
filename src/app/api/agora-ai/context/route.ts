/**
 * GET /api/agora-ai/context?workspaceId=XXX
 *
 * Returns the workspace context prompt for client-side AI providers (e.g. Ollama).
 * Authenticated — requires valid Firebase session and workspace membership.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { normalizeFolderPath } from '@/lib/folder-utils';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const workspaceId = request.nextUrl.searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ context: '' });
    }

    if (!isPersonalWorkspaceId(workspaceId)) {
      const isMember = await isWorkspaceMember(workspaceId, auth.uid);
      if (!isMember) {
        return NextResponse.json({ error: 'No tienes acceso a este workspace' }, { status: 403 });
      }
    }

    const parts: string[] = [];

    // Fetch documents
    try {
      const docsSnap = await adminDb
        .collection('documents')
        .where('workspaceId', '==', workspaceId)
        .limit(30)
        .get();

      if (!docsSnap.empty) {
        type FireDoc = { id: string } & Record<string, unknown>;
        const textDocs = docsSnap.docs
          .map(d => ({ id: d.id, ...d.data() }) as FireDoc)
          .filter(d => d['type'] === 'text');

        // Extract folder names from documents (normalized for consistency)
        const folderNames = new Set<string>();
        docsSnap.docs.forEach(d => {
          const data = d.data() as Record<string, unknown>;
          if (typeof data['folder'] === 'string' && data['folder']) folderNames.add(normalizeFolderPath(data['folder']));
          if (data['type'] === 'folder' && typeof data['name'] === 'string') folderNames.add(normalizeFolderPath(data['name']));
        });

        if (folderNames.size > 0) {
          // Detect class-like folders and annotate the latest one
          const sortedFolders = Array.from(folderNames).sort();
          const classPattern = /clase\s*(\d+)/i;
          let latestClassFolder = '';
          let latestClassNum = -1;
          for (const f of sortedFolders) {
            const m = f.match(classPattern);
            if (m && parseInt(m[1]) > latestClassNum) {
              latestClassNum = parseInt(m[1]);
              latestClassFolder = f;
            }
          }

          parts.push('## Carpetas del workspace');
          parts.push('(Estas carpetas representan la estructura del curso. Usa `list_documents` con el nombre de carpeta para ver su contenido.)\n');
          for (const folder of sortedFolders) {
            const isLatest = latestClassFolder && folder.includes(latestClassFolder.split('/').pop()!);
            parts.push(`- ${folder}${isLatest ? ' ← ÚLTIMA CLASE (la más reciente)' : ''}`);
          }
          parts.push('');
        }

        if (textDocs.length > 0) {
          // Only include document titles (not content) to keep prompt short
          // and force the agent to use read_document for actual content
          parts.push('## Documentos disponibles en el workspace');
          parts.push('(Usa `read_document` para leer el contenido de cualquiera de estos documentos)\n');
          for (const doc of textDocs) {
            const folder = doc['folder'] ? ` [carpeta: ${normalizeFolderPath(String(doc['folder']))}]` : '';
            parts.push(`- ${String(doc['name'] || 'Sin título')} (ID: ${doc.id})${folder}`);
          }
          parts.push('');
        }
      }
    } catch {
      // non-fatal
    }

    // Fetch semantic state
    try {
      const semSnap = await adminDb
        .collection('workspaceSemanticStates')
        .doc(workspaceId)
        .get();

      if (semSnap.exists) {
        const sem = semSnap.data() as Record<string, unknown>;
        const concepts = (sem['concepts'] as Array<Record<string, unknown>> | undefined) ?? [];
        const fragments = (sem['fragments'] as Array<Record<string, unknown>> | undefined) ?? [];

        if (concepts.length > 0) {
          parts.push('\n## Conceptos semánticos del workspace\n');
          for (const c of concepts.slice(0, 25)) {
            const def = String(c['definition'] ?? c['formula'] ?? '');
            parts.push(`- **${String(c['title'] ?? '')}**${def ? `: ${def}` : ''}`);
          }
        }

        if (fragments.length > 0) {
          parts.push('\n## Fragmentos de texto marcados\n');
          for (const f of fragments.slice(0, 20)) {
            const text = String(f['text'] ?? '').slice(0, 250);
            parts.push(`- [${String(f['kind'] ?? '')}] "${text}"`);
          }
        }
      }
    } catch {
      // non-fatal
    }

    const context = parts.length === 0
      ? ''
      : `# Contexto del workspace Agora\n\n${parts.join('\n')}`;

    return NextResponse.json({ context });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
