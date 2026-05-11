import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { isNasConfigured, presignUploadPart } from '@/lib/nas-storage';

export const runtime = 'nodejs';

const PRESIGN_TTL_SECONDS = 60 * 60;

interface SignPartBody {
    uploadId: string;
    storagePath: string;
    partNumber: number;
}

const parseBody = (raw: unknown): { ok: true; value: SignPartBody } | { ok: false; error: string } => {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'body must be an object' };
    const r = raw as Record<string, unknown>;
    const uploadId = typeof r['uploadId'] === 'string' ? r['uploadId'].trim() : '';
    const storagePath = typeof r['storagePath'] === 'string' ? r['storagePath'].trim() : '';
    const partNumber = typeof r['partNumber'] === 'number' ? r['partNumber'] : Number.NaN;
    if (!uploadId) return { ok: false, error: 'uploadId ausente' };
    if (!storagePath) return { ok: false, error: 'storagePath ausente' };
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
        return { ok: false, error: 'partNumber must be integer in [1, 10000]' };
    }
    return { ok: true, value: { uploadId, storagePath, partNumber } };
};

const validatePathOwnership = async (
    storagePath: string,
    uid: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
    if (storagePath.startsWith(`users/${uid}/`)) return { ok: true };
    const wsMatch = storagePath.match(/^workspaces\/([^/]+)\//);
    if (!wsMatch || !wsMatch[1]) {
        return { ok: false, status: 403, error: 'Access denied: Invalid storage path' };
    }
    const workspaceId = wsMatch[1];
    const member = await isWorkspaceMember(workspaceId, uid);
    if (!member) return { ok: false, status: 403, error: 'Forbidden' };
    return { ok: true };
};

export async function POST(req: NextRequest) {
    try {
        if (!isNasConfigured()) {
            return NextResponse.json({ error: 'NAS storage not configured' }, { status: 503 });
        }
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const rawBody = await req.json().catch(() => null);
        const parsed = parseBody(rawBody);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

        const { uploadId, storagePath, partNumber } = parsed.value;

        const ownership = await validatePathOwnership(storagePath, auth.uid);
        if (!ownership.ok) {
            return NextResponse.json({ error: ownership.error }, { status: ownership.status });
        }

        const signedUrl = await presignUploadPart(storagePath, uploadId, partNumber, PRESIGN_TTL_SECONDS);

        return NextResponse.json({
            signedUrl,
            partNumber,
            expiresIn: PRESIGN_TTL_SECONDS
        });
    } catch (error: unknown) {
        console.error('[multipart/sign-part]', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
