/**
 * GET  /api/git/me        — info Forgejo del user (login, URL web, lista de repos).
 * POST /api/git/me        — emite un token Forgejo nuevo para acceso externo.
 *
 * Pensado para que un usuario pueda clonar sus repos con `git` directo
 * desde su máquina sin pasar por agora-cli (que es para sync runtime).
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { isForgejoConfigured, userLoginFor, getForgejoApiUrl, getForgejoOrg, listUserRepos, issueTokenForUser } from '@/lib/forgejo';
import { getErrorMessage } from '@/lib/error-utils';

const stripApiSuffix = (url: string | null): string | null => {
    if (!url) return null;
    return url.replace(/\/api\/v\d+\/?$/, '').replace(/\/$/, '');
};

export async function GET(req: NextRequest) {
    try {
        if (!isForgejoConfigured()) return NextResponse.json({ error: 'Forgejo not configured' }, { status: 503 });
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const login = userLoginFor(auth.uid);
        const apiUrl = getForgejoApiUrl();
        const webUrl = stripApiSuffix(apiUrl);

        const repos = await listUserRepos(auth.uid).catch(() => []);

        return NextResponse.json({
            login,
            webUrl,
            apiUrl,
            org: getForgejoOrg(),
            repos: repos.map((r) => ({
                fullName: r.full_name,
                cloneUrl: r.clone_url ?? null,
                sshUrl: r.ssh_url ?? null,
                htmlUrl: r.html_url ?? null,
                private: r.private ?? null
            }))
        });
    } catch (e) {
        console.error('[git/me GET] error:', getErrorMessage(e));
        return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        if (!isForgejoConfigured()) return NextResponse.json({ error: 'Forgejo not configured' }, { status: 503 });
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const tokenName = `web-clone-${Date.now()}`;
        const token = await issueTokenForUser(auth.uid, tokenName);
        if (!token) {
            return NextResponse.json({
                error: 'No se pudo emitir token. Provisión de repo pendiente?'
            }, { status: 502 });
        }
        return NextResponse.json({
            ok: true,
            login: userLoginFor(auth.uid),
            token,
            tokenName,
            note: 'Guarda este token: solo se muestra una vez. Úsalo como contraseña al hacer git clone/push.'
        });
    } catch (e) {
        console.error('[git/me POST] error:', getErrorMessage(e));
        return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
}
