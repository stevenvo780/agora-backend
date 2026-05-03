/**
 * /api/snippets — GET (list) y POST (create).
 * Auth Firebase. Snippets viven en Firestore (sin MinIO).
 */
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { parseSnippetCreatePayload } from '@/lib/contracts';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const workspaceId = req.nextUrl.searchParams.get('workspaceId') || PERSONAL_WORKSPACE_ID;
    if (!isPersonalWorkspaceId(workspaceId)) {
      const member = await isWorkspaceMember(workspaceId, auth.uid);
      if (!member) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    let query: FirebaseFirestore.Query = adminDb
      .collection('snippets')
      .where('workspaceId', '==', workspaceId);

    if (isPersonalWorkspaceId(workspaceId)) {
      query = query.where('ownerId', '==', auth.uid);
    }

    const snap = await query.orderBy('order', 'asc').limit(500).get();

    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return NextResponse.json(items);
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
      const member = await isWorkspaceMember(resolvedWorkspaceId, auth.uid);
      if (!member) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
