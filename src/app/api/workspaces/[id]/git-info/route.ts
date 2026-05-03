/**
 * GET /api/workspaces/[id]/git-info
 * Devuelve URLs del repo del workspace si ya fue provisionado.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';

export const runtime = 'nodejs';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { adminDb } from '@/lib/firebase-admin';
import { isForgejoConfigured, repoNameForWorkspace, getForgejoApiUrl, getForgejoOrg } from '@/lib/forgejo';
import { getErrorMessage } from '@/lib/error-utils';

type RouteContext = { params: Promise<{ id: string }> };

interface WorkspaceGitBlock {
    forgejoRepo?: string;
    cloneUrl?: string;
    sshUrl?: string;
    htmlUrl?: string;
}

export async function GET(req: NextRequest, context: RouteContext) {
    try {
        if (!isForgejoConfigured()) {
            return NextResponse.json({ error: 'Forgejo not configured' }, { status: 503 });
        }
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const { id: workspaceId } = await context.params;

        let ownerUid = auth.uid;
        if (isPersonalWorkspaceId(workspaceId)) {
            ownerUid = auth.uid;
        } else {
            const wsSnap = await adminDb.collection('workspaces').doc(workspaceId).get();
            if (!wsSnap.exists) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
            const wsData = wsSnap.data() as { ownerId?: string; members?: string[]; git?: WorkspaceGitBlock } | undefined;
            const memberOk = (wsData?.members ?? []).includes(auth.uid)
                || wsData?.ownerId === auth.uid
                || await isWorkspaceMember(workspaceId, auth.uid);
            if (!memberOk) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            ownerUid = wsData?.ownerId ?? auth.uid;
            if (wsData?.git?.cloneUrl) {
                return NextResponse.json({
                    provisioned: true,
                    workspaceId,
                    repoFullName: wsData.git.forgejoRepo ?? null,
                    cloneUrl: wsData.git.cloneUrl ?? null,
                    sshUrl: wsData.git.sshUrl ?? null,
                    htmlUrl: wsData.git.htmlUrl ?? null
                });
            }
        }

        // Si no había git block en Firestore, derivar URL canónica.
        const apiUrl = getForgejoApiUrl();
        const o = getForgejoOrg();
        const repoName = repoNameForWorkspace(workspaceId, ownerUid);
        const fullName = `${o}/${repoName}`;
        const baseHttp = apiUrl ? apiUrl.replace(/\/$/, '') : 'https://git.proxy.humanizar-dev.cloud';
        const cloneUrl = `${baseHttp}/${fullName}.git`;
        const htmlUrl = `${baseHttp}/${fullName}`;

        return NextResponse.json({
            provisioned: false,
            workspaceId,
            repoFullName: fullName,
            cloneUrl,
            sshUrl: null,
            htmlUrl
        });
    } catch (e) {
        console.error('[workspaces/git-info] error:', getErrorMessage(e));
        return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
}
