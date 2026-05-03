/**
 * GET /api/diag — health check sin auth (no expone secretos).
 */
import { NextResponse } from '@/lib/http/next-server';
import { isNasConfigured, getNasBucket, objectExists } from '@/lib/nas-storage';
import { isForgejoConfigured, getForgejoApiUrl, getForgejoOrg } from '@/lib/forgejo';
import { env } from '@/lib/env';

export const runtime = 'nodejs';

export async function GET() {
    const envSummary = {
        AGORA_USE_NAS: process.env.AGORA_USE_NAS ?? null,
        NAS_S3_ENDPOINT: env.NAS_S3_ENDPOINT() || null,
        NAS_S3_BUCKET: env.NAS_S3_BUCKET() || null,
        NAS_S3_HAS_KEY: Boolean(env.NAS_S3_ACCESS_KEY()),
        NAS_S3_HAS_SECRET: Boolean(env.NAS_S3_SECRET_KEY()),
        FORGEJO_API_URL: env.FORGEJO_API_URL() || null,
        FORGEJO_HAS_TOKEN: Boolean(env.FORGEJO_ADMIN_TOKEN()),
        FORGEJO_ORG: env.FORGEJO_ORG(),
        FIREBASE_DATABASE_URL: env.FIREBASE_DATABASE_URL() || null,
        FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID() || null
    };

    const nas: Record<string, unknown> = { configured: isNasConfigured(), endpoint: envSummary.NAS_S3_ENDPOINT, bucket: getNasBucket() };
    if (nas.configured) {
        try {
            await objectExists('__diag__/__never__');
            nas.health = 'ok';
        } catch (e) {
            nas.health = 'fail';
            nas.error = (e as Error).message?.slice(0, 200);
        }
    }

    const forgejo: Record<string, unknown> = { configured: isForgejoConfigured(), apiUrl: getForgejoApiUrl(), org: getForgejoOrg() };
    if (forgejo.configured) {
        try {
            const res = await fetch(`${forgejo.apiUrl}/api/v1/version`, {
                headers: { Authorization: `token ${env.FORGEJO_ADMIN_TOKEN()}` }
            });
            forgejo.status = res.status;
            forgejo.health = res.ok ? 'ok' : 'fail';
        } catch (e) {
            forgejo.health = 'fail';
            forgejo.error = (e as Error).message?.slice(0, 200);
        }
    }

    return NextResponse.json({ env: envSummary, nas, forgejo, ts: new Date().toISOString() });
}
