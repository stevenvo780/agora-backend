import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { evaluate, listProfiles } from '@/lib/st-api';
import { lookupApiKey, consumeQuota, type STApiKey } from '@/lib/st-api-keys';
import { checkRateLimit } from '@/lib/st-rate-limit';
import { getErrorMessage } from '@/lib/error-utils';

// st-lang's exports map no permite `require('@stevenvo780/st-lang/package.json')`,
// así que resolvemos el subpath permitido `/api` y subimos al package root para
// leer la versión instalada — evita el hardcode que quedó desfasado (3.2.3 vs 4.15.x).
function resolveStVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    let dir = path.dirname(req.resolve('@stevenvo780/st-lang/api'));
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === '@stevenvo780/st-lang' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through al fallback
  }
  return 'unknown';
}

export const ST_VERSION = resolveStVersion();

const MAX_FORMULA_LEN = 8000;
const EVAL_TIMEOUT_MS = 5000;

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
  if (obj.formula.length > MAX_FORMULA_LEN) return null;
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

export class EvalTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ST evaluation exceeded ${timeoutMs}ms`);
    this.name = 'EvalTimeoutError';
  }
}

// runEval es síncrono y CPU-bound, así que el timer SOLO acota el contrato HTTP:
// una fórmula patológica deja de colgar la respuesta indefinidamente, pero mientras
// la llamada síncrona corre el event loop sigue bloqueado hasta que retorna. La
// interrupción real de CPU exigiría worker_threads/aislamiento dentro de st-lang,
// fuera del alcance de esta ruta. El `Promise.race` además cubre el caso de que
// runEval pase a ser async en el futuro.
async function runEvalWithTimeout(
  runEval: STDeps['runEval'],
  source: string,
  timeoutMs: number
): Promise<Awaited<ReturnType<STDeps['runEval']>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EvalTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => runEval(source)), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

  if (
    rawBody !== null &&
    typeof rawBody === 'object' &&
    typeof (rawBody as Record<string, unknown>).formula === 'string' &&
    ((rawBody as Record<string, unknown>).formula as string).length > MAX_FORMULA_LEN
  ) {
    return corsJson(
      { error: 'formula_too_long', detail: `formula must be at most ${MAX_FORMULA_LEN} characters` },
      { status: 400 }
    );
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
    const result = await runEvalWithTimeout(deps.runEval, source, EVAL_TIMEOUT_MS);
    const ms = Date.now() - start;
    return corsJson({ result, errors: result.diagnostics ?? [], ms, version: ST_VERSION });
  } catch (err) {
    if (err instanceof EvalTimeoutError) {
      console.error('[st-public] ST evaluation timed out after', EVAL_TIMEOUT_MS, 'ms');
      const res = corsJson(
        { error: 'evaluation_timeout', detail: `evaluation exceeded ${EVAL_TIMEOUT_MS}ms` },
        { status: 503 }
      );
      res.headers.set('Retry-After', '1');
      return res;
    }
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
