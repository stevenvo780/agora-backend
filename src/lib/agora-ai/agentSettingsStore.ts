/**
 * Settings del agente IA por usuario en Firestore.
 *
 *   users/{uid}/agentSettings/config
 *
 * Controlan la autonomía del agente:
 *   - mainModel: modelo para el trabajo real (override del default del provider).
 *   - auxModel:  modelo barato/flash para clasificaciones (¿el agente solo pide
 *                permiso?). Si falta, se usa el flash por defecto del provider.
 *   - autonomousMode: cuando ON, los puntos donde el agente pregunta "¿continúo?"
 *                se auto-resuelven con "sí, continúa" usando el auxModel.
 *
 * Es dato que cruza Firestore: se valida con schema en el borde, nunca con
 * `as Tipo` directo.
 */
import { z } from 'zod';
import { adminDb } from '@/lib/firebase-admin';
import { parseZod, type ParseResult } from '@agora/contracts';
import type { AIProvider } from '@/lib/agora-ai/types';

/** Defaults flash/baratos por provider para el auxModel de clasificación. */
export const DEFAULT_FLASH_MODELS: Record<Exclude<AIProvider, 'ollama'>, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  gemini: 'gemini-2.0-flash',
  deepseek: 'deepseek-v4-flash'
};

export const agentSettingsSchema = z.object({
  mainModel: z.string().trim().min(1).max(200).optional(),
  auxModel: z.string().trim().min(1).max(200).optional(),
  autonomousMode: z.boolean().optional()
}).strip();

export type AgentSettings = z.infer<typeof agentSettingsSchema>;

export interface ResolvedAgentSettings {
  /** Modelo de trabajo: el del settings si existe, si no el que llega en el request. */
  mainModel: string;
  /** Modelo barato para clasificación: settings → flash del provider. */
  auxModel: string;
  autonomousMode: boolean;
}

export const parseAgentSettings = (input: unknown): ParseResult<AgentSettings> =>
  parseZod(agentSettingsSchema, input);

const DEFAULTS: Required<Pick<AgentSettings, 'autonomousMode'>> = {
  autonomousMode: false
};

interface CacheEntry {
  value: AgentSettings | null;
  expiresAt: number;
}

const TTL_MS = 60 * 1000;
const cache = new Map<string, CacheEntry>();

/**
 * Lee y valida los settings del usuario. Devuelve `null` si no hay doc o el
 * contenido es inválido (en cuyo caso el caller aplica defaults sensatos).
 */
export async function getAgentSettings(uid: string): Promise<AgentSettings | null> {
  const now = Date.now();
  const cached = cache.get(uid);
  if (cached && cached.expiresAt > now) return cached.value;

  let value: AgentSettings | null = null;
  try {
    const snap = await adminDb
      .collection('users').doc(uid)
      .collection('agentSettings').doc('config')
      .get();
    if (snap.exists) {
      const parsed = parseAgentSettings(snap.data());
      if (parsed.ok) {
        value = parsed.value;
      } else {
        console.warn('[agentSettings] doc inválido, ignorado:', parsed.error);
      }
    }
  } catch (error) {
    console.warn('[agentSettings] lectura falló:', error instanceof Error ? error.message : error);
  }

  cache.set(uid, { value, expiresAt: now + TTL_MS });
  return value;
}

/**
 * Resuelve los settings efectivos combinando lo guardado con defaults sensatos.
 * `requestModel` es el modelo que llegó en el request (ya con el default del
 * provider aplicado por el route handler) y se usa como mainModel si el user
 * no lo sobreescribió en settings.
 */
export function resolveAgentSettings(
  settings: AgentSettings | null,
  provider: Exclude<AIProvider, 'ollama'>,
  requestModel: string
): ResolvedAgentSettings {
  const mainModel = settings?.mainModel?.trim() || requestModel;
  const auxModel = settings?.auxModel?.trim() || DEFAULT_FLASH_MODELS[provider];
  const autonomousMode = settings?.autonomousMode ?? DEFAULTS.autonomousMode;
  return { mainModel, auxModel, autonomousMode };
}
