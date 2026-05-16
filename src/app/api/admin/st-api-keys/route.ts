import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { resolveInternalToolSecret, isInternalToolSecretAuthorized } from '@/lib/agora-ai/internalToolAuth';
import { createApiKey } from '@/lib/st-api-keys';
import { getErrorMessage } from '@/lib/error-utils';
import type { STApiKey } from '@/lib/st-api-keys';

export interface CreateKeyBody {
  owner: string;
  scope: STApiKey['scope'];
  dailyLimit?: number;
}

export function parseCreateKeyBody(raw: unknown): CreateKeyBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.owner !== 'string' || obj.owner.trim() === '') return null;
  const scope = obj.scope;
  if (scope !== 'public-eval' && scope !== 'public-derive') return null;
  if (obj.dailyLimit !== undefined) {
    if (typeof obj.dailyLimit !== 'number' || !Number.isFinite(obj.dailyLimit) || obj.dailyLimit < 1) return null;
  }
  return {
    owner: obj.owner.trim(),
    scope,
    dailyLimit: typeof obj.dailyLimit === 'number' ? Math.floor(obj.dailyLimit) : undefined
  };
}

export interface AdminKeyDeps {
  resolveSecret: () => string;
  createKey: (owner: string, scope: STApiKey['scope'], dailyLimit?: number) => Promise<{ key: string; hash: string }>;
}

export const defaultAdminDeps: AdminKeyDeps = {
  resolveSecret: resolveInternalToolSecret,
  createKey: createApiKey
};

export async function handleCreateApiKey(req: NextRequest, deps: AdminKeyDeps = defaultAdminDeps): Promise<Response> {
  const secret = deps.resolveSecret();
  const provided = (req.headers.get('x-backend-internal-secret') ?? '').trim();

  if (!isInternalToolSecretAuthorized(provided, secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const parsed = parseCreateKeyBody(rawBody);
  if (!parsed) {
    return NextResponse.json(
      { error: 'invalid_params', detail: 'owner (string), scope ("public-eval"|"public-derive") required; dailyLimit (number >= 1) optional' },
      { status: 400 }
    );
  }

  try {
    const { key, hash } = await deps.createKey(parsed.owner, parsed.scope, parsed.dailyLimit);
    return NextResponse.json(
      { key, hash, owner: parsed.owner, scope: parsed.scope, dailyLimit: parsed.dailyLimit ?? 1000 },
      { status: 201 }
    );
  } catch (err) {
    console.error('[admin/st-api-keys] Error creating key:', getErrorMessage(err));
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  return handleCreateApiKey(req);
}
