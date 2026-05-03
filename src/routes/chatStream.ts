import type { Request, Response } from 'express';
import { authenticateRequest, isPersonalWorkspaceId, isWorkspaceMember } from '../lib/auth.js';
import { runProviderConversation } from '../agora-ai/providerAdapters.js';
import { claimAgoraAgentRequest } from '../agora-ai/rateLimit.js';
import { normalizeAgentAccessPolicy } from '../agora-ai/accessPolicy.js';
import { executeToolViaHub } from '../lib/toolProxy.js';
import type {
  AgentMode,
  AgentRequestBody,
  AgentStreamEvent,
  AIProvider
} from '../agora-ai/types.js';

const DEFAULT_MODELS: Record<Exclude<AIProvider, 'ollama'>, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  gemini: 'gemini-2.0-flash',
  deepseek: 'deepseek-v4-flash'
};

const SOFT_BUDGET_MS = 760_000;            // Cloud Run soporta hasta 60min; truncamos a ~12.7 min para UX

export async function chatStreamHandler(req: Request, res: Response) {
  const auth = await authenticateRequest(req, res);
  if (!auth) return;

  const body = req.body as AgentRequestBody | undefined;
  if (!body) {
    res.status(400).json({ error: 'JSON inválido' });
    return;
  }

  const {
    messages,
    workspaceId = 'personal',
    provider,
    apiKey = '',
    model = '',
    mode = 'agent',
    accessPolicy: rawAccessPolicy
  } = body;

  const effectiveMode: AgentMode = mode === 'chat' ? 'chat' : 'agent';
  const accessPolicy = normalizeAgentAccessPolicy(rawAccessPolicy);

  if (!messages?.length) { res.status(400).json({ error: 'messages is required' }); return; }
  if (!provider) { res.status(400).json({ error: 'provider is required' }); return; }
  if (provider === 'ollama') {
    res.status(400).json({ error: 'Ollama se conecta directamente desde el navegador' });
    return;
  }
  if (!apiKey) {
    res.status(400).json({ error: `API key requerida para ${provider}` });
    return;
  }

  if (workspaceId && !isPersonalWorkspaceId(workspaceId)) {
    const isMember = await isWorkspaceMember(workspaceId, auth.uid);
    if (!isMember) {
      res.status(403).json({ error: 'No tienes acceso a este workspace' });
      return;
    }
  }

  const claim = claimAgoraAgentRequest(`${auth.uid}:${workspaceId}:${provider}:stream`, {
    minIntervalMs: 900,
    maxConcurrent: 2
  });
  if (!claim.ok) {
    res.status(429)
      .setHeader('Retry-After', String(Math.ceil(claim.retryAfterMs / 1000)))
      .json({ error: `Demasiadas solicitudes seguidas a ${provider}. Intenta en ${Math.ceil(claim.retryAfterMs / 1000)}s.` });
    return;
  }

  // Cabeceras SSE.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  const send = (payload: AgentStreamEvent) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const keepAlive = setInterval(() => {
    if (!closed) res.write(`: keep-alive\n\n`);
  }, 15_000);

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    claim.release();
    res.end();
  };

  req.on('close', close);

  const startedAt = Date.now();
  const softTimeout = setTimeout(() => {
    send({
      type: 'complete',
      reply: 'La respuesta del agente fue truncada por el límite de tiempo del servidor. Intenta una solicitud más específica o divídela en pasos.',
      agentRun: {
        mode: effectiveMode,
        provider,
        iterations: 0,
        steps: [],
        finalReply: '',
        truncated: true
      }
    });
    close();
  }, SOFT_BUDGET_MS);

  try {
    send({ type: 'connected' });
    send({ type: 'status', status: 'Preparando contexto del workspace…' });

    const agentRun = await runProviderConversation({
      provider,
      apiKey,
      model: model || DEFAULT_MODELS[provider],
      messages: messages.filter(m => m.role !== 'system'),
      contextPrompt: '', // contexto del workspace lo construye una tool específica del hub
      mode: effectiveMode,
      executionContext: {
        workspaceId,
        uid: auth.uid,
        email: auth.email,
        authToken: auth.token,
        accessPolicy,
        elapsedBudgetMs: () => Date.now() - startedAt,
        maxBudgetMs: SOFT_BUDGET_MS,
        executeAgentTool: executeToolViaHub
      },
      callbacks: {
        onStatus: async (status) => send({ type: 'status', status }),
        onStep: async (step) => send({ type: 'step', step })
      }
    });

    clearTimeout(softTimeout);
    send({ type: 'complete', reply: agentRun.finalReply, agentRun });
    close();
  } catch (error) {
    clearTimeout(softTimeout);
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[chatStream]', message);
    send({ type: 'error', error: message });
    close();
  }
}
