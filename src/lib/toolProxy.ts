import type {
  AgentExecutionContext,
  AgentToolCall,
  AgentToolExecutionResult
} from '../agora-ai/types.js';

/**
 * Cliente HTTP que delega la ejecución de tools al hub Next.js
 * (el endpoint /api/agora-ai/internal/execute-tool en Vercel).
 *
 * El hub valida el JWT del usuario, ejecuta el tool con todas sus deps
 * (Firestore, MinIO, Forgejo, worker socket.io) y devuelve el resultado.
 *
 * Este patrón nos permite tener el LLM streaming en Cloud Run (sin cap de
 * tiempo) mientras las tools siguen viviendo donde están sus dependencias.
 */

const HUB_INTERNAL_URL = process.env.HUB_INTERNAL_URL || 'https://agora.elenxos.com';
const HUB_INTERNAL_SECRET = process.env.HUB_INTERNAL_SECRET || '';
const TOOL_TIMEOUT_MS = 25_000;

export async function executeToolViaHub(
  call: AgentToolCall,
  ctx: AgentExecutionContext
): Promise<AgentToolExecutionResult> {
  if (!ctx.authToken) {
    return {
      ok: false, name: call.name, callId: call.id,
      summary: 'No hay JWT del usuario para delegar el tool al hub.',
      error: 'missing_auth_token'
    };
  }
  if (!HUB_INTERNAL_SECRET) {
    return {
      ok: false, name: call.name, callId: call.id,
      summary: 'HUB_INTERNAL_SECRET no configurado en el servidor.',
      error: 'hub_secret_missing'
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);

  try {
    const res = await fetch(`${HUB_INTERNAL_URL}/api/agora-ai/internal/execute-tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ctx.authToken}`,
        'X-Hub-Internal-Secret': HUB_INTERNAL_SECRET
      },
      body: JSON.stringify({
        call,
        ctx: {
          workspaceId: ctx.workspaceId,
          uid: ctx.uid,
          email: ctx.email,
          accessPolicy: ctx.accessPolicy,
          // omitimos elapsedBudgetMs / executeAgentTool: no son serializables
          origin: ctx.origin,
          llmEndpoint: ctx.llmEndpoint,
          llmModel: ctx.llmModel
        }
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false, name: call.name, callId: call.id,
        summary: `Hub respondió ${res.status} ejecutando ${call.name}`,
        error: text.slice(0, 500) || `HTTP ${res.status}`
      };
    }

    const data = await res.json() as AgentToolExecutionResult;
    return data;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false, name: call.name, callId: call.id,
      summary: `Error contactando el hub para ${call.name}: ${msg}`,
      error: msg
    };
  } finally {
    clearTimeout(timeout);
  }
}
