/**
 * /api/agora-ai/models
 *
 * GET  → catálogo estático (modelCatalog.json) con ventanas de contexto reales.
 * POST → mismo catálogo, mergeado con datos en vivo de Anthropic y Gemini cuando
 *        se proveen las API keys del usuario. Los demás providers (OpenAI, DeepSeek,
 *        xAI) no exponen contextWindow vía API; el JSON sigue siendo la única fuente.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getRefreshedCatalog, getStaticCatalog } from '@/lib/agora-ai/modelCatalog';

export const maxDuration = 30;

export async function GET(_request: NextRequest) {
  return NextResponse.json(getStaticCatalog(), {
    headers: { 'cache-control': 'public, max-age=300, s-maxage=300' }
  });
}

export async function POST(request: NextRequest) {
  let body: { anthropicApiKey?: unknown; geminiApiKey?: unknown } = {};
  try { body = await request.json() as typeof body; }
  catch { /* sin body — devuelve estático */ }
  const anthropicApiKey = typeof body.anthropicApiKey === 'string' && body.anthropicApiKey.trim()
    ? body.anthropicApiKey.trim() : undefined;
  const geminiApiKey = typeof body.geminiApiKey === 'string' && body.geminiApiKey.trim()
    ? body.geminiApiKey.trim() : undefined;
  if (!anthropicApiKey && !geminiApiKey) {
    return NextResponse.json(getStaticCatalog());
  }
  const catalog = await getRefreshedCatalog({ anthropicApiKey, geminiApiKey });
  return NextResponse.json(catalog);
}
