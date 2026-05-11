/**
 * POST /api/workspaces/[id]/provision-git
 * Asegura repo Forgejo para el workspace y devuelve URLs + token inicial (si user nuevo).
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';

export const runtime = 'nodejs';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { provisionWorkspaceRepo, isForgejoConfigured } from '@/lib/forgejo';
import { seedGitignore } from '@/lib/workspace-defaults';
import { adminAuth, adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { getErrorMessage } from '@/lib/error-utils';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, context: RouteContext) {
    try {
        if (!isForgejoConfigured()) {
            return NextResponse.json({ error: 'Forgejo not configured' }, { status: 503 });
        }
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const { id: workspaceId } = await context.params;

        let workspaceName: string | undefined;
        let extraCollaborators: string[] | undefined;

        if (!isPersonalWorkspaceId(workspaceId)) {
            const wsSnap = await adminDb.collection('workspaces').doc(workspaceId).get();
            if (!wsSnap.exists) {
                return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
            }
            const wsData = wsSnap.data() as { name?: string; members?: string[]; ownerId?: string } | undefined;
            const members = Array.isArray(wsData?.members) ? wsData?.members : [];
            const ownerOk = wsData?.ownerId === auth.uid;
            const memberOk = members?.includes(auth.uid) ?? await isWorkspaceMember(workspaceId, auth.uid);
            if (!ownerOk && !memberOk) {
                return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            }
            workspaceName = wsData?.name;
            extraCollaborators = members;
        } else {
            workspaceName = 'Personal';
        }

        let email: string | undefined = auth.email ?? undefined;
        let displayName: string | undefined;
        try {
            const u = await adminAuth.getUser(auth.uid);
            email = u.email ?? email;
            displayName = u.displayName ?? undefined;
        } catch { /* insecure mode */ }

        const result = await provisionWorkspaceRepo({
            ownerUid: auth.uid,
            email,
            displayName,
            workspaceId,
            workspaceName,
            extraCollaborators
        });

        if (!result.forgejoUser?.login || !result.repo?.full_name) {
            return NextResponse.json({
                error: 'Forgejo user/repo inválido',
                detail: { login: result.forgejoUser?.login ?? null, repo: result.repo?.full_name ?? null }
            }, { status: 502 });
        }

        // Sanea undefined para Firestore (no acepta undefined en values).
        const userPatch = {
            forgejo: {
                login: result.forgejoUser.login,
                provisionedAt: FieldValue.serverTimestamp()
            }
        };
        await adminDb.collection('users').doc(auth.uid).set(userPatch, { merge: true });

        // Solo escribir workspace doc si NO es personal (los personal no viven en /workspaces).
        if (!workspaceId.startsWith('personal:') && workspaceId !== 'personal') {
            const gitPatch: Record<string, unknown> = {
                forgejoRepo: result.repo.full_name,
                cloneUrl: result.repo.clone_url ?? null,
                sshUrl: result.repo.ssh_url ?? null,
                htmlUrl: result.repo.html_url ?? null,
                provisionedAt: FieldValue.serverTimestamp()
            };
            await adminDb.collection('workspaces').doc(workspaceId).set({ git: gitPatch }, { merge: true });
        }

        seedGitignore(workspaceId, auth.uid).catch((e) => console.warn('[provision-git] seed .gitignore failed:', e?.message));

        return NextResponse.json({
            ok: true,
            workspaceId,
            created: result.created,
            repo: {
                fullName: result.repo.full_name,
                htmlUrl: result.repo.html_url,
                cloneUrl: result.repo.clone_url,
                sshUrl: result.repo.ssh_url
            },
            forgejoLogin: result.forgejoUser.login,
            token: result.token,
            tokenName: result.tokenName,
            tokenNote: result.token
                ? 'Guarda este token. Úsalo como password en git push HTTPS. No se mostrará de nuevo.'
                : 'Token no emitido (user ya existía). Genera uno desde el panel Forgejo si lo necesitas.'
        });
    } catch (e) {
        console.error('[workspaces/provision-git] error', e);
        return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
}
