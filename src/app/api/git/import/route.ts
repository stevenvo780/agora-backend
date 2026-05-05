/**
 * POST /api/git/import — Importa un repo externo a Forgejo.
 *
 * Body: { url: string, name?: string, authToken?: string, authUsername?: string, authPassword?: string, private?: boolean, mirror?: boolean }
 *
 * Forgejo se encarga del clone server-side via su API `/api/v1/repos/migrate`.
 * El repo queda en la org `agora`, con write access para el usuario que lo
 * importó. NO crea workspace nuevo: se devuelve la `cloneUrl` para que el
 * user lo use desde su máquina o lo asocie luego a un workspace.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';
import { isForgejoConfigured, migrateRepo } from '@/lib/forgejo';
import { getErrorMessage } from '@/lib/error-utils';
import { assertPublicHttpUrl } from '@/lib/security/url-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ImportBody {
  url?: unknown;
  name?: unknown;
  description?: unknown;
  authToken?: unknown;
  authUsername?: unknown;
  authPassword?: unknown;
  private?: unknown;
  mirror?: unknown;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export async function POST(req: NextRequest) {
  try {
    if (!isForgejoConfigured()) {
      return NextResponse.json({ error: 'Forgejo not configured' }, { status: 503 });
    }
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const body = (await req.json().catch(() => null)) as ImportBody | null;
    if (!body) return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });

    const url = isStr(body.url) ? body.url.trim() : '';
    if (!url) return NextResponse.json({ error: 'url es requerida' }, { status: 400 });

    try {
      await assertPublicHttpUrl(url);
    } catch (urlErr) {
      return NextResponse.json({ error: getErrorMessage(urlErr) }, { status: 400 });
    }

    // TOCTOU: Forgejo realiza su propio DNS lookup al hacer migrate; un atacante
    // podría rebindear el dominio entre nuestra resolución y la suya. Forgejo no
    // expone una forma de pasar la IP resuelta directamente, así que la ventana
    // existe a nivel del backend de Forgejo.
    const repo = await migrateRepo({
      ownerUid: auth.uid,
      email: auth.email ?? undefined,
      cloneAddr: url,
      repoName: isStr(body.name) ? body.name : undefined,
      description: isStr(body.description) ? body.description : undefined,
      authToken: isStr(body.authToken) ? body.authToken : undefined,
      authUsername: isStr(body.authUsername) ? body.authUsername : undefined,
      authPassword: isStr(body.authPassword) ? body.authPassword : undefined,
      private: body.private !== false,
      mirror: body.mirror === true
    });

    return NextResponse.json({
      ok: true,
      repo: {
        fullName: repo.full_name,
        cloneUrl: repo.clone_url,
        sshUrl: repo.ssh_url,
        htmlUrl: repo.html_url,
        private: repo.private
      }
    });
  } catch (err) {
    const message = getErrorMessage(err);
    console.warn('[git/import] failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
