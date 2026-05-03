import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { getErrorMessage } from '@/lib/error-utils';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const body = await req.json();
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : PERSONAL_WORKSPACE_ID;
    const userIds: string[] = Array.isArray(body?.userIds)
      ? (body.userIds as unknown[]).filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];

    if (userIds.length === 0) {
      return NextResponse.json({ users: [] });
    }

    if (!isPersonalWorkspaceId(workspaceId)) {
      const member = await isWorkspaceMember(workspaceId, auth.uid);
      if (!member) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const uniqueIds = Array.from(new Set<string>(userIds)).slice(0, 200);
    const filteredIds = isPersonalWorkspaceId(workspaceId)
      ? uniqueIds.filter(id => id === auth.uid)
      : uniqueIds;

    if (filteredIds.length === 0) {
      return NextResponse.json({ users: [] });
    }

    const refs = filteredIds.map(id => adminDb.collection('users').doc(id));
    const snaps = await adminDb.getAll(...refs);
    const users = snaps.map((snap) => {
      const data = snap.exists ? (snap.data() as Record<string, unknown>) : null;
      return {
        uid: snap.id,
        email: (data?.email as string | undefined) ?? null,
        displayName: (data?.displayName as string | undefined) ?? null
      };
    });

    return NextResponse.json({ users });
  } catch (error: unknown) {
    console.error('Error looking up users:', getErrorMessage(error));
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
