/**
 * /api/snippets — GET (list) y POST (create).
 * Auth Firebase. Snippets viven en Firestore (sin MinIO).
 */
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { isWorkspaceMember, canWriteWorkspace, requireAuth } from '@/lib/server-auth';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { parseSnippetCreatePayload } from '@agora/contracts';

const SNIPPETS_MAX_PAGE = 500;

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const params = req.nextUrl.searchParams;
    const workspaceId = params.get('workspaceId') || PERSONAL_WORKSPACE_ID;
    if (!isPersonalWorkspaceId(workspaceId)) {
      const member = await isWorkspaceMember(workspaceId, auth.uid);
      if (!member) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const limitParam = params.get('limit');
    const parsedLimit = limitParam === null ? SNIPPETS_MAX_PAGE : Number(limitParam);
    const requestedLimit = Number.isFinite(parsedLimit) ? parsedLimit : SNIPPETS_MAX_PAGE;
    const pageSize = Math.min(Math.max(1, requestedLimit), SNIPPETS_MAX_PAGE);
    const cursorDocId = params.get('cursor') ?? null;

    let query: FirebaseFirestore.Query = adminDb
      .collection('snippets')
      .where('workspaceId', '==', workspaceId);

    if (isPersonalWorkspaceId(workspaceId)) {
      query = query.where('ownerId', '==', auth.uid);
    }

    query = query.orderBy('order', 'asc').limit(pageSize);

    if (cursorDocId) {
      const cursorDoc = await adminDb.collection('snippets').doc(cursorDocId).get();
      // El cursor debe pertenecer al mismo scope o se ignora: un id ajeno solo
      // posiciona por `order` y devolvería páginas inconsistentes, no datos ajenos.
      const sameWorkspace = cursorDoc.exists && cursorDoc.get('workspaceId') === workspaceId;
      const sameOwner = !isPersonalWorkspaceId(workspaceId) || cursorDoc.get('ownerId') === auth.uid;
      if (sameWorkspace && sameOwner) {
        query = query.startAfter(cursorDoc);
      }
    }

    const snap = await query.get();
    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const lastDoc = snap.docs[snap.docs.length - 1];
    const nextCursor = snap.size === pageSize && lastDoc ? lastDoc.id : null;

    return NextResponse.json({ items, cursor: nextCursor });
  } catch (error) {
    console.error('GET /api/snippets error', getErrorMessage(error));
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const body = await req.json().catch(() => null);
    const parsed = parseSnippetCreatePayload(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { title, description, markdown, workspaceId: wsRaw, category, order } = parsed.value;
    const resolvedWorkspaceId = wsRaw ?? PERSONAL_WORKSPACE_ID;

    if (!isPersonalWorkspaceId(resolvedWorkspaceId)) {
      const canWrite = await canWriteWorkspace(resolvedWorkspaceId, auth.uid);
      if (!canWrite) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    // Idempotencia: si ya existe un snippet con mismo ownerId+workspaceId+title+markdown,
    // devolvemos ese en vez de crear duplicado. Abrir la galería re-siembra los defaults
    // y sin esto se acumulan cientos de copias (bug QA-W2: ~466 duplicados observados).
    const dupSnap = await adminDb
      .collection('snippets')
      .where('ownerId', '==', auth.uid)
      .where('workspaceId', '==', resolvedWorkspaceId)
      .where('title', '==', title)
      .where('markdown', '==', markdown)
      .limit(1)
      .get();
    if (!dupSnap.empty) {
      const existingDoc = dupSnap.docs[0];
      if (existingDoc) {
        return NextResponse.json(
          { id: existingDoc.id, ...existingDoc.data(), dedup: 'already-exists' },
          { status: 200 }
        );
      }
    }

    const data: Record<string, unknown> = {
      title,
      description,
      markdown,
      workspaceId: resolvedWorkspaceId,
      category,
      order,
      ownerId: auth.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const ref = await adminDb.collection('snippets').add(data);
    return NextResponse.json({ id: ref.id, ...data }, { status: 201 });
  } catch (error) {
    console.error('POST /api/snippets error', getErrorMessage(error));
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
