/**
 * Helpers puros (sin side-effects) usados por worker.ts para validar paths,
 * detectar comandos destructivos y safe-reads, y para construir comandos
 * compatibles con la whitelist del agente (agent-command-policy.mjs en el
 * worker, que NO acepta `cd`).
 *
 * Aislado en su propio módulo para poder testearlo sin instanciar firebase-admin.
 */

export const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  /\brm\b/,
  /\bdd\b/,
  /\bshred\b/,
  /\btruncate\b/,
  /\bmkfs/,
  /\bmv\b[^|]*\s+\/(?!tmp\/agora-tmp)/,
  /(?:^|[^|>&])>\s*\S/
];

export const SAFE_READ_ONLY_BINARIES = new Set([
  'ls', 'pwd', 'cat', 'echo', 'head', 'tail', 'wc', 'grep', 'find', 'sort',
  'uniq', 'cut', 'awk', 'sed', 'tr', 'diff', 'stat', 'file', 'date',
  'tree', 'jq', 'true', 'false'
]);

export function isDestructiveShellCommand(command: string): boolean {
  return DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export function isSafeReadOnlyCommand(command: string): boolean {
  if (isDestructiveShellCommand(command)) return false;
  const segments = command.split(/(?:\|\||&&|;|\|)/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    const head = tokens[0];
    if (!head) return false;
    const realHead = /^[A-Z_][A-Z0-9_]*=/.test(head) ? tokens[1] : head;
    if (!realHead) return false;
    const binary = realHead.split('/').pop();
    if (!binary || !SAFE_READ_ONLY_BINARIES.has(binary)) return false;
  }
  return true;
}

export function validateWorkspaceRelPath(rawPath: unknown): string {
  const value = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!value) throw new Error('path es requerido');
  if (value.includes('\0')) throw new Error('path contiene caracteres nulos');
  if (value.startsWith('/')) throw new Error('path debe ser relativo a /workspace');
  if (value.split('/').some((part) => part === '..')) throw new Error('path traversal no permitido');
  return value;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Construye el comando de lectura. Antes prefijaba con `cd /workspace &&` lo
 * que rompía la whitelist del worker. Ahora el worker resuelve cwd a /workspace
 * automáticamente cuando cwd === '.'.
 */
export function buildReadCommand(relPath: string, maxBytes: number): string {
  return `head -c ${maxBytes} ${shellQuote(relPath)}`;
}

/**
 * Construye el comando de escritura como pipeline echo|base64|>file. El path
 * relativo (no comienza con '/') es seguro porque agent-command-policy sólo
 * bloquea redirects a rutas absolutas fuera de /workspace y /tmp/agora-tmp.
 */
export function buildWriteCommand(relPath: string, base64Content: string): string {
  const dirname = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  const mkdir = dirname ? `mkdir -p ${shellQuote(dirname)} && ` : '';
  return `${mkdir}echo ${shellQuote(base64Content)} | base64 -d > ${shellQuote(relPath)}`;
}
