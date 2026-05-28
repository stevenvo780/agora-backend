import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { getErrorMessage } from '@/lib/error-utils';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';
import { WorkspaceType } from '@/types/workspace';
import { syncWorkspaceClaims } from '@/lib/workspace-claims';
import { seedSyncignore } from '@/lib/workspace-defaults';

/**
 * Valida que los query params `ownerId`/`email` coincidan con el JWT.
 * Antes los ignorábamos silenciosamente (devolvíamos workspaces:[]), lo que
 * confundía al cliente. Falla rápido con `{ status: 400, error: ... }`.
 */
export function validateWorkspaceOwnerParams(
  searchParams: URLSearchParams,
  auth: { uid: string; email?: string | null }
): { ok: true } | { ok: false; status: 400; error: string } {
  const ownerIdParam = searchParams.get('ownerId');
  if (ownerIdParam !== null && ownerIdParam.trim() && ownerIdParam.trim() !== auth.uid) {
    return { ok: false, status: 400, error: 'ownerId no coincide con la autenticación' };
  }
  const emailParam = searchParams.get('email');
  if (emailParam !== null && emailParam.trim()) {
    const normalizedParam = emailParam.trim().toLowerCase();
    const authEmail = (auth.email ?? '').toLowerCase().trim();
    if (!authEmail || normalizedParam !== authEmail) {
      return { ok: false, status: 400, error: 'email no coincide con la autenticación' };
    }
  }
  return { ok: true };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const url = new URL(req.url);
    const paramCheck = validateWorkspaceOwnerParams(url.searchParams, auth);
    if (!paramCheck.ok) {
      return NextResponse.json({ error: paramCheck.error }, { status: paramCheck.status });
    }

    const memberSnap = await adminDb
      .collection('workspaces')
      .where('members', 'array-contains', auth.uid)
      .get();
    const memberWorkspaces: Record<string, unknown>[] = memberSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    const memberIds = new Set(memberWorkspaces.map(ws => ws.id as string));
    let inviteWorkspaces: Record<string, unknown>[] = [];

    if (auth.email) {
      const normalizedEmail = auth.email.toLowerCase().trim();
      if (normalizedEmail) {
        const inviteSnap = await adminDb
          .collection('workspaces')
          .where('pendingInvites', 'array-contains', normalizedEmail)
          .get();
        inviteWorkspaces = inviteSnap.docs
          // Si el user ya es miembro, la invitación pendiente es stale —
          // no la incluimos.
          .filter(doc => !memberIds.has(doc.id))
          .map(doc => ({ id: doc.id, ...doc.data(), pending: true as const }));
      }
    }

    // Combinamos members + pendingInvites en `workspaces` para que cualquier
    // consumidor que sólo lea ese campo (curl, CLI, agente IA) vea las
    // invitaciones pendientes y pueda actuar sobre ellas. Las invitaciones
    // llevan `pending: true` para que el cliente las distinga de los
    // workspaces donde el user ya es member. `invites` queda en el response
    // como vista filtrada (compat con el slice Redux + UI del dashboard).
    const combinedWorkspaces: unknown[] = [...memberWorkspaces, ...inviteWorkspaces];
    return NextResponse.json({ workspaces: combinedWorkspaces, invites: inviteWorkspaces });
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
