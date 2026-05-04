import catalogJson from '@/lib/agora-ai/modelCatalog.json' with { type: 'json' };

export type ModelFamily = 'deepseek' | 'anthropic' | 'openai' | 'google' | 'xai' | 'ollama';
export type ModelVerified = 'official' | 'community' | 'unverified';

export interface CatalogModel {
  id: string;
  family: ModelFamily;
  label: string;
  contextWindow: number;
  maxOutputTokens: number;
  verified: ModelVerified;
  notes?: string;
}

export interface ModelCatalog {
  lastUpdated: string;
  models: CatalogModel[];
}

const RAW_CATALOG = catalogJson as { lastUpdated: string; models: CatalogModel[] };

const STATIC_CATALOG: ModelCatalog = {
  lastUpdated: RAW_CATALOG.lastUpdated,
  models: RAW_CATALOG.models
};

const MODEL_BY_ID = new Map<string, CatalogModel>(
  STATIC_CATALOG.models.map((model) => [model.id, model])
);

export function getStaticCatalog(): ModelCatalog {
  return STATIC_CATALOG;
}

export function getCatalogModel(modelId: string): CatalogModel | null {
  if (!modelId) return null;
  const direct = MODEL_BY_ID.get(modelId);
  if (direct) return direct;
  // Algunos providers usan ids con sufijo de fecha; intentamos prefijo coincidente.
  const prefixMatch = STATIC_CATALOG.models.find((model) =>
    modelId.startsWith(model.id) || model.id.startsWith(modelId)
  );
  return prefixMatch ?? null;
}

/** Ventana de contexto del modelo. Si no se conoce, devuelve un default conservador
 *  (32K) — preferimos subestimar antes que mentirle al usuario. */
export function getContextWindow(family: ModelFamily | string, modelId: string): number {
  const model = getCatalogModel(modelId);
  if (model) return model.contextWindow;
  switch (family) {
    case 'anthropic': return 200_000;
    case 'openai': return 128_000;
    case 'deepseek': return 128_000;
    case 'google': return 1_048_576;
    case 'xai': return 131_072;
    case 'ollama': return 32_768;
    default: return 32_768;
  }
}

export function getMaxOutputTokens(family: ModelFamily | string, modelId: string): number {
  const model = getCatalogModel(modelId);
  if (model) return model.maxOutputTokens;
  switch (family) {
    case 'anthropic': return 64_000;
    case 'openai': return 16_384;
    case 'deepseek': return 8_192;
    case 'google': return 8_192;
    case 'xai': return 16_000;
    default: return 4_096;
  }
}

interface RefreshOptions {
  anthropicApiKey?: string;
  geminiApiKey?: string;
  fetchTimeoutMs?: number;
}

interface ProviderListEntry {
  id: string;
  family: ModelFamily;
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

async function fetchAnthropicModels(apiKey: string, timeoutMs: number): Promise<ProviderListEntry[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal: controller.signal
    });
    if (!res.ok) return [];
    const json = await res.json() as { data?: Array<Record<string, unknown>> };
    return (json.data ?? []).map((m): ProviderListEntry => ({
      id: String(m.id ?? ''),
      family: 'anthropic',
      label: typeof m.display_name === 'string' ? m.display_name : undefined,
      contextWindow: typeof m.max_input_tokens === 'number' ? m.max_input_tokens : undefined,
      maxOutputTokens: typeof m.max_tokens === 'number' ? m.max_tokens : undefined
    })).filter((m) => m.id);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGeminiModels(apiKey: string, timeoutMs: number): Promise<ProviderListEntry[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
      signal: controller.signal
    });
    if (!res.ok) return [];
    const json = await res.json() as { models?: Array<Record<string, unknown>> };
    return (json.models ?? []).map((m): ProviderListEntry => {
      const name = String(m.name ?? '');
      const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
      return {
        id,
        family: 'google',
        label: typeof m.displayName === 'string' ? m.displayName : undefined,
        contextWindow: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined,
        maxOutputTokens: typeof m.outputTokenLimit === 'number' ? m.outputTokenLimit : undefined
      };
    }).filter((m) => m.id);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/** Devuelve el catálogo estático mergeado con datos en vivo de Anthropic y Gemini.
 *  Para los providers que NO exponen contextWindow vía API (OpenAI, DeepSeek, xAI),
 *  el JSON sigue siendo la única fuente. */
export async function getRefreshedCatalog(options: RefreshOptions = {}): Promise<ModelCatalog> {
  const timeoutMs = options.fetchTimeoutMs ?? 4000;
  const live: ProviderListEntry[] = [];
  const tasks: Promise<void>[] = [];
  if (options.anthropicApiKey) {
    tasks.push(fetchAnthropicModels(options.anthropicApiKey, timeoutMs).then((items) => { live.push(...items); }));
  }
  if (options.geminiApiKey) {
    tasks.push(fetchGeminiModels(options.geminiApiKey, timeoutMs).then((items) => { live.push(...items); }));
  }
  await Promise.all(tasks);

  if (live.length === 0) return STATIC_CATALOG;

  const merged = new Map<string, CatalogModel>(MODEL_BY_ID);
  for (const entry of live) {
    const existing = merged.get(entry.id);
    if (existing) {
      merged.set(entry.id, {
        ...existing,
        contextWindow: entry.contextWindow ?? existing.contextWindow,
        maxOutputTokens: entry.maxOutputTokens ?? existing.maxOutputTokens,
        label: entry.label ?? existing.label,
        verified: 'official'
      });
    } else if (entry.contextWindow) {
      merged.set(entry.id, {
        id: entry.id,
        family: entry.family,
        label: entry.label ?? entry.id,
        contextWindow: entry.contextWindow,
        maxOutputTokens: entry.maxOutputTokens ?? getMaxOutputTokens(entry.family, entry.id),
        verified: 'official',
        notes: 'Detectado vía API del provider.'
      });
    }
  }

  return {
    lastUpdated: STATIC_CATALOG.lastUpdated,
    models: Array.from(merged.values())
  };
}
