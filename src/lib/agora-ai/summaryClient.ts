import type { SummaryProvider } from '@/lib/agora-ai/conversationCompactor';
import type { AIProvider, ChatMessage } from '@/lib/agora-ai/types';

interface SummaryClientOptions {
  provider: Exclude<AIProvider, 'ollama'>;
  apiKey: string;
  model: string;
  /** Timeout duro: si tarda más, se cancela y el compactador usa fallback local. */
  timeoutMs?: number;
}

/** Cliente de compactación: hace una llamada single-turn al provider sin tools,
 *  con max_tokens limitado para que el resumen sea barato. */
export function createSummaryClient(options: SummaryClientOptions): SummaryProvider {
  return {
    summarize: async ({ systemPrompt, messages, maxTokens }) => {
      const timeoutMs = options.timeoutMs ?? 15_000;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        switch (options.provider) {
          case 'openai':
          case 'deepseek':
            return await summarizeOpenAICompat({ ...options, systemPrompt, messages, maxTokens, signal: controller.signal });
          case 'anthropic':
            return await summarizeAnthropic({ ...options, systemPrompt, messages, maxTokens, signal: controller.signal });
          case 'gemini':
            return await summarizeGemini({ ...options, systemPrompt, messages, maxTokens, signal: controller.signal });
          default: {
            const _exhaustive: never = options.provider;
            void _exhaustive;
            throw new Error(`Provider no soportado para compactación: ${options.provider}`);
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}

interface InternalArgs extends SummaryClientOptions {
  systemPrompt: string;
  messages: ChatMessage[];
  maxTokens: number;
  signal: AbortSignal;
}

async function summarizeOpenAICompat(args: InternalArgs): Promise<string> {
  const endpoint = args.provider === 'deepseek'
    ? 'https://api.deepseek.com/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.apiKey}` },
    signal: args.signal,
    body: JSON.stringify({
      model: args.model,
      max_tokens: args.maxTokens,
      messages: [
        { role: 'system', content: args.systemPrompt },
        ...args.messages.map((m) => ({
          role: m.role === 'system' ? 'user' : m.role,
          content: m.content
        }))
      ]
    })
  });
  if (!res.ok) throw new Error(`Summary HTTP ${res.status}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

async function summarizeAnthropic(args: InternalArgs): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': args.apiKey,
      'anthropic-version': '2023-06-01'
    },
    signal: args.signal,
    body: JSON.stringify({
      model: args.model,
      max_tokens: args.maxTokens,
      system: args.systemPrompt,
      messages: args.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    })
  });
  if (!res.ok) throw new Error(`Summary HTTP ${res.status}`);
  const data = await res.json() as { content?: Array<{ type?: string; text?: string }> };
  return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
}

async function summarizeGemini(args: InternalArgs): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${args.model}:generateContent?key=${args.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: args.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: args.systemPrompt }] },
        contents: args.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          })),
        generationConfig: { maxOutputTokens: args.maxTokens }
      })
    }
  );
  if (!res.ok) throw new Error(`Summary HTTP ${res.status}`);
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('\n').trim();
}
