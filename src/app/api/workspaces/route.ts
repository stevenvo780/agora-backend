import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { getErrorMessage } from '@/lib/error-utils';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';
import { WorkspaceType } from '@/types/workspace';
import { syncWorkspaceClaims } from '@/lib/workspace-claims';
import { seedSyncignore } from '@/lib/workspace-defaults';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    let workspaces: unknown[] = [];
    let invites: unknown[] = [];

    const snapshot = await adminDb
      .collection('workspaces')
      .where('members', 'array-contains', auth.uid)
      .get();
    workspaces = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    if (auth.email) {
      const normalizedEmail = auth.email.toLowerCase().trim();
      const inviteSnap = await adminDb
        .collection('workspaces')
        .where('pendingInvites', 'array-contains', normalizedEmail)
        .get();
      invites = inviteSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }

    return NextResponse.json({ workspaces, invites });
  } catch (error: unknown) {
    console.error('Error fetching workspaces:', getErrorMessage(error));
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const body = await req.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const workspaceData = {
      name,
      ownerId: auth.uid,
      members: [auth.uid],
      pendingInvites: [],
      type: WorkspaceType.Shared,
      createdAt: FieldValue.serverTimestamp()
    };

    const docRef = await adminDb.collection('workspaces').add(workspaceData);

    // Sync custom claims so security rules work without get()/exists()
    syncWorkspaceClaims(auth.uid).catch(() => {});

    // Siembra `.syncignore` con defaults — el daemon lo aplica para evitar que
    // archivos temp del editor (swp, ~) se conviertan en docs zombie.
    seedSyncignore(docRef.id, auth.uid).catch((e) => console.warn('[workspaces] seed .syncignore failed:', e?.message));

    return NextResponse.json({
      id: docRef.id,
      name,
      ownerId: auth.uid,
      members: [auth.uid],
      pendingInvites: [],
      type: WorkspaceType.Shared
    });
  } catch (error: unknown) {
    console.error('Error creating workspace:', getErrorMessage(error));
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
