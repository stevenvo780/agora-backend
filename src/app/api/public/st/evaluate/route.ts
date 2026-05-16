import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { evaluate, listProfiles } from '@/lib/st-api';
import { lookupApiKey, consumeQuota, type STApiKey } from '@/lib/st-api-keys';
import { checkRateLimit } from '@/lib/st-rate-limit';
import { getErrorMessage } from '@/lib/error-utils';

export const ST_VERSION = '3.2.3';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-ST-API-Key'
};

function corsJson(body: unknown, init: ResponseInit = {}): Response {
  const res = NextResponse.json(body, init);
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export interface EvaluateBody {
  formula: string;
  profile: string;
}

export function parseEvaluateBody(raw: unknown): EvaluateBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.formula !== 'string' || obj.formula.trim() === '') return null;
  if (typeof obj.profile !== 'string' || obj.profile.trim() === '') return null;
  return { formula: obj.formula, profile: obj.profile };
}

export function isValidSTProfile(profile: string): boolean {
  const profiles = listProfiles() as unknown[];
  return profiles.some((p) =>
    typeof p === 'string'
      ? p === profile
      : typeof p === 'object' && p !== null && 'name' in p && (p as { name: string }).name === profile
  );
}

export interface STDeps {
  lookup: (key: string) => Promise<STApiKey | null>;
  consume: (key: STApiKey) => Promise<boolean>;
  rateLimit: (hash: string) => { allowed: boolean; retryAfterMs?: number };
  runEval: (source: string) => ReturnType<typeof evaluate>;
}

export const defaultDeps: STDeps = {
  lookup: lookupApiKey,
  consume: consumeQuota,
  rateLimit: checkRateLimit,
  runEval: evaluate
};

export async function handleEvaluate(req: NextRequest, deps: STDeps = defaultDeps): Promise<Response> {
  const rawKey = req.headers.get('x-st-api-key') ?? '';
  if (!rawKey) {
    return corsJson({ error: 'missing_api_key' }, { status: 401 });
  }

  let apiKey: STApiKey | null;
  try {
    apiKey = await deps.lookup(rawKey);
  } catch (err) {
    console.error('[st-public] Error looking up API key:', getErrorMessage(err));
    return corsJson({ error: 'internal_error' }, { status: 500 });
  }

  if (!apiKey) {
    return corsJson({ error: 'invalid_api_key' }, { status: 401 });
  }

  const rateCheck = deps.rateLimit(apiKey.hash);
  if (!rateCheck.allowed) {
    const res = corsJson({ error: 'rate_limited', retryAfterMs: rateCheck.retryAfterMs }, { status: 429 });
    res.headers.set('Retry-After', String(Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)));
    return res;
  }

  if (apiKey.quota.usedToday >= apiKey.quota.dailyLimit) {
    return corsJson({ error: 'quota_exceeded' }, { status: 429 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return corsJson({ error: 'invalid_body' }, { status: 400 });
  }

  const parsed = parseEvaluateBody(rawBody);
  if (!parsed) {
    return corsJson({ error: 'invalid_params', detail: 'formula and profile are required strings' }, { status: 400 });
  }

  if (!isValidSTProfile(parsed.profile)) {
    return corsJson({ error: 'invalid_profile', detail: `Unknown profile: ${parsed.profile}` }, { status: 400 });
  }

  let quotaConsumed = false;
  try {
    quotaConsumed = await deps.consume(apiKey);
  } catch (err) {
    console.error('[st-public] Error consuming quota:', getErrorMessage(err));
    return corsJson({ error: 'internal_error' }, { status: 500 });
  }

  if (!quotaConsumed) {
    return corsJson({ error: 'quota_exceeded' }, { status: 429 });
  }

  const source = `logic ${parsed.profile}\n${parsed.formula}`;
  const start = Date.now();
  try {
    const result = deps.runEval(source);
    const ms = Date.now() - start;
    return corsJson({ result, errors: result.diagnostics ?? [], ms, version: ST_VERSION });
  } catch (err) {
    console.error('[st-public] ST evaluation error:', getErrorMessage(err));
    return corsJson({ error: 'evaluation_error', detail: getErrorMessage(err) }, { status: 500 });
  }
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest): Promise<Response> {
  return handleEvaluate(req);
}
