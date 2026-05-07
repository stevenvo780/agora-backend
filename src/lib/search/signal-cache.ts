/**
 * Cache LRU server-side de señales extraídas (frontmatter + headings + tags).
 *
 * Motivación: extractSignals() corre regex caros por keystroke. Para WS de
 * 1000+ docs, recomputar cada llamada come CPU. La key incluye updatedAt,
 * por lo que la invalidación es natural cuando el doc cambia.
 *
 * Se mantiene en memoria del proceso Cloud Run; un cold start lo vacía.
 * Sin TTL: la key cambia con updatedAt.
 */

const MAX_ENTRIES = 500;

export class LruSignalCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly maxEntries: number = MAX_ENTRIES) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refrescar orden LRU
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, value);
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * Construye una key estable a partir del `updatedAt` Firestore (Timestamp,
 * string ISO, número, null). Si no hay updatedAt, usamos 'novers' — degrada
 * a "no caching efectivo" pero no rompe.
 */
export function buildSignalCacheKey(docId: string, updatedAt: unknown): string {
  let stamp = 'novers';
  if (updatedAt && typeof updatedAt === 'object') {
    const obj = updatedAt as { toMillis?: () => number; seconds?: number; nanoseconds?: number };
    if (typeof obj.toMillis === 'function') {
      try { stamp = String(obj.toMillis()); } catch { /* keep novers */ }
    } else if (typeof obj.seconds === 'number') {
      stamp = `${obj.seconds}.${obj.nanoseconds ?? 0}`;
    }
  } else if (typeof updatedAt === 'number') {
    stamp = String(updatedAt);
  } else if (typeof updatedAt === 'string') {
    stamp = updatedAt;
  }
  return `${docId}::${stamp}`;
}

// Instancia compartida para extractSignals(). Exportada para tests.
export const signalCache = new LruSignalCache<unknown>(MAX_ENTRIES);
