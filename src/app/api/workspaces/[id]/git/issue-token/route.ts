/**
 * POST /api/workspaces/[id]/git/issue-token
 * Emite un token Forgejo nuevo para el user autenticado. El cliente lo guarda
 * en localStorage y lo usa para hablar directo con Forgejo (cliente→NAS sin Vercel).
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';

export const runtime = 'nodejs';
import { isForgejoConfigured, issueTokenForUser, userLoginFor } from '@/lib/forgejo';
import { getErrorMessage } from '@/lib/error-utils';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, _context: RouteContext) {
    try {
        if (!isForgejoConfigured()) return NextResponse.json({ error: 'Forgejo not configured' }, { status: 503 });
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const tokenName = `agora-cli-${Date.now()}`;
        const sha1 = await issueTokenForUser(auth.uid, tokenName);
        if (!sha1) {
            return NextResponse.json({
                error: 'No se pudo emitir token. Asegúrate de haber provisionado el repo primero.'
            }, { status: 502 });
        }
        return NextResponse.json({
            ok: true,
            token: sha1,
            tokenName,
            forgejoLogin: userLoginFor(auth.uid),
            note: 'Guarda este token en tu cliente. Es válido hasta que lo revoques en Forgejo.'
        });
    } catch (e) {
        console.error('[git/issue-token] error:', getErrorMessage(e));
        return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
}
