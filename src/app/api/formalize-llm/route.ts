/**
 * POST /api/formalize-llm
 *
 * Server-side proxy for LLM-backed formalization.
 * Accepts optional client-side LLM configuration (endpoint, apiKey, model, provider)
 * so users can point to their own Ollama / Open WebUI instance.
 * Falls back to server env vars when no client config is provided.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';
import {
  formalizeWithLLM,
  type FormalizeWithLLMOptions,
  type LogicProfile,
  type LLMConfig
} from '@stevenvo780/autologic';
import {
  FORMALIZATION_CONTRACT_VERSION,
  clampConfidence,
  emptyFormalizationResultPayload,
  type FormalizationResultPayload,
  type FormalizationEngine
} from '@/lib/formalization-contract';

// Server-side defaults (set via Vercel env vars or .env)
const SERVER_OPENWEBUI_ENDPOINT = process.env.OPENWEBUI_ENDPOINT || '';
const SERVER_OPENWEBUI_API_KEY = process.env.OPENWEBUI_API_KEY || '';
const SERVER_OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT || 'http://localhost:11434/api/chat';
const SERVER_OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'autologic-formalizer';

type LLMProvider = LLMConfig['provider'];

function buildLLMConfig(body: Record<string, unknown>): LLMConfig {
  // Client-supplied overrides
  const clientProvider = body.llmProvider as LLMProvider | undefined;
  const clientEndpoint = (body.llmEndpoint as string)?.trim() || '';
  const clientApiKey = (body.llmApiKey as string)?.trim() || '';
  const clientModel = (body.llmModel as string)?.trim() || '';

  // If the client sends explicit config, use it
  if (clientEndpoint) {
    const provider: LLMProvider = clientProvider || (clientApiKey ? 'openwebui' : 'ollama');
    return {
      provider,
      apiKey: clientApiKey,
      endpoint: clientEndpoint,
      model: clientModel || SERVER_OLLAMA_MODEL
    };
  }

  // Otherwise fall back to server env vars
  if (SERVER_OPENWEBUI_ENDPOINT && SERVER_OPENWEBUI_API_KEY) {
    return {
      provider: 'openwebui',
      apiKey: SERVER_OPENWEBUI_API_KEY,
      endpoint: SERVER_OPENWEBUI_ENDPOINT,
      model: SERVER_OLLAMA_MODEL
    };
  }

  // Last resort: direct Ollama on localhost / LAN
  return {
    provider: 'ollama',
    apiKey: '',
    endpoint: SERVER_OLLAMA_ENDPOINT,
    model: SERVER_OLLAMA_MODEL
  };
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    if (!auth) {
      return NextResponse.json(
        emptyFormalizationResultPayload('llm', 'No autorizado'),
        { status: 401 }
      );
    }

    const body = await request.json();
    const { text, profile, language } = body as {
      text: string;
      profile: LogicProfile;
      language?: 'es' | 'en';
    };

    if (!text?.trim()) {
      return NextResponse.json(
        emptyFormalizationResultPayload('llm', 'Text is required'),
        { status: 400 }
      );
    }

    const llmConfig = buildLLMConfig(body);

    const opts: FormalizeWithLLMOptions = {
      profile: profile || 'classical.propositional',
      language: language || 'es',
      includeComments: true,
      validateOutput: true,
      llmConfig,
      abortOnLinterErrors: false
    };

    const result = await formalizeWithLLM(text, opts);

    const warningCount = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
    const errorCount = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
    const confidence = clampConfidence(
      0.9
      - (warningCount * 0.08)
      - (errorCount * 0.18)
      - ((result.linterDiagnostics?.length ?? 0) * 0.03)
    );

    const responsePayload: FormalizationResultPayload = {
      contractVersion: FORMALIZATION_CONTRACT_VERSION,
      ok: result.ok,
      stCode: result.stCode,
      ast: result.llmRawAst ?? null,
      linterDiagnostics: result.linterDiagnostics ?? [],
      diagnostics: result.diagnostics,
      atomCount: result.atoms.size,
      formulaCount: result.formulas.length,
      claimCount: result.llmRawAst?.conclusions?.length ?? 0,
      confidence,
      engine: 'llm' as FormalizationEngine,
      patterns: ['llm_extracted'],
      trace: {
        inferredByRules: false,
        inferredByLLM: true,
        userEdited: false
      }
    };
    return NextResponse.json(responsePayload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      emptyFormalizationResultPayload('llm', message),
      { status: 500 }
    );
  }
}
