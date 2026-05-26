/**
 * Autonomía del agente IA.
 *
 * El loop agéntico termina el turno en cuanto el modelo emite texto sin
 * tool_calls. Modelos como DeepSeek tienden a "anunciar" un plan en prosa
 * ("Ahora creo los 6 documentos…") sin llamar tools en esa vuelta — entonces
 * el loop ve cero tool_calls y corta la tarea a la mitad.
 *
 * Este módulo decide cuándo ese texto-sin-tools es realmente un final genuino
 * (el agente terminó / hizo una pregunta sustantiva al user) vs. un anuncio que
 * debe empujarse a seguir ejecutando.
 */

/**
 * Patrones de "anuncio de intención": el agente dice que VA a hacer algo en
 * vez de hacerlo. Disparan auto-continue incluso fuera de autonomousMode
 * (es el fix conservador del bug — empujamos a actuar, no a parar).
 */
const ANNOUNCE_PATTERNS: RegExp[] = [
  /\b(ahora|voy a|procedo a|empiezo a|comenzaré|continuaré|seguir[ée]|a continuación)\b[^.!?]*\b(crear|cre[oa]|generar|gener[oa]|escribir|escrib[oa]|añadir|agregar|implementar|ejecutar|hacer|armar|configurar|construir|actualizar|modificar)\b/i,
  /\b(let me|i'?ll|i will|now i|going to|next,? i)\b[^.!?]*\b(create|generate|write|add|implement|run|make|build|configure|update|set up)\b/i,
  /\bd[ée]jame (crear|generar|escribir|hacer|empezar|continuar)\b/i,
  /\b(primero|luego|después|finalmente)\b[^.!?]*\b(crear[ée]|generar[ée]|crear[ée]|voy a)\b/i
];

/**
 * Patrones de "pide permiso / confirmación": el agente pregunta si puede
 * seguir en vez de seguir. En autonomousMode se auto-responden "sí, continúa".
 */
const CONFIRM_PATTERNS: RegExp[] = [
  /¿\s*(contin[úu]o|sigo|procedo|empiezo|lo hago|los? (creo|genero|escribo|hago)|quieres? que|deseas? que|te parece|avanzo|paso a)/i,
  /\b(¿|)\s*(should i|shall i|do you want me to|would you like me to|may i|can i (go|proceed|continue))\b/i,
  /\b(continú[ao]|procedo|sigo)\s*\?/i,
  /\b(me das? el ok|confirmas?|esper(o|aré) tu (ok|confirmaci[óo]n|visto bueno|respuesta))\b/i,
  /\b(let me know if you('|’)?d like me to (proceed|continue|go ahead))\b/i
];

export type TurnIntent =
  | 'announce' // anunció que va a hacer algo, sin ejecutar
  | 'confirm'  // pide permiso / confirmación al user
  | 'final';   // respuesta genuinamente final (terminó / pregunta sustantiva)

/**
 * Clasifica el texto de un turno SIN tool_calls. Heurística pura (sin red),
 * usada como base y como fallback del clasificador con auxModel.
 */
export function classifyTextOnlyTurn(text: string): TurnIntent {
  const trimmed = (text || '').trim();
  if (!trimmed) return 'final';
  // Confirmación tiene prioridad: si pregunta permiso, es punto de bypass.
  if (CONFIRM_PATTERNS.some((re) => re.test(trimmed))) return 'confirm';
  if (ANNOUNCE_PATTERNS.some((re) => re.test(trimmed))) return 'announce';
  return 'final';
}

/** Mensaje user inyectado para empujar al agente a actuar (auto-continue). */
export const AUTO_CONTINUE_PROMPT =
  'Continúa ejecutando la tarea hasta completarla usando las herramientas '
  + 'disponibles. NO anuncies lo que vas a hacer ni pidas permiso: actúa ahora. '
  + 'Si la tarea ya está completa, indícalo brevemente sin llamar más tools.';

/** Mensaje user inyectado cuando el bypass auto-confirma una pregunta. */
export const AUTO_CONFIRM_PROMPT =
  'Sí, continúa. Procede con la acción que propusiste y completa la tarea sin '
  + 'pedir más confirmaciones; usa las herramientas necesarias ahora.';

interface ClassifierClient {
  /** Llamada single-turn barata al auxModel. Devuelve texto crudo. */
  classify: (prompt: string) => Promise<string>;
}

/**
 * Clasificador con auxModel: decide si el último mensaje del agente "solo pide
 * permiso/continuar". Devuelve true si debe auto-confirmarse. Ante cualquier
 * fallo del modelo, cae a la heurística regex.
 */
export async function isPermissionOnlyMessage(
  text: string,
  client: ClassifierClient | null
): Promise<boolean> {
  const heuristic = classifyTextOnlyTurn(text) === 'confirm';
  if (!client) return heuristic;
  try {
    const prompt =
      'Eres un clasificador binario. El siguiente es el último mensaje de un '
      + 'agente de IA que está ejecutando una tarea para un usuario. Responde '
      + 'SOLO con "SI" si el mensaje únicamente pide permiso o confirmación '
      + 'para continuar (sin aportar información nueva que el usuario deba '
      + 'decidir), o "NO" si contiene una pregunta sustantiva, una decisión '
      + 'real que requiere al usuario, o es una respuesta final.\n\n'
      + `Mensaje:\n"""${text.slice(0, 2000)}"""\n\nRespuesta (SI/NO):`;
    const raw = (await client.classify(prompt)).trim().toUpperCase();
    if (raw.startsWith('SI') || raw.startsWith('SÍ') || raw.startsWith('YES')) return true;
    if (raw.startsWith('NO')) return false;
    return heuristic;
  } catch {
    return heuristic;
  }
}
