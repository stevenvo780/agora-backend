import type { NextRequest } from './next-server';

/**
 * Extrae la IP real del cliente. Toma el primer segmento de X-Forwarded-For
 * (el más cercano al cliente), o X-Real-Ip si no hay XFF, o 'unknown'.
 * Usar el header completo sin parsear permite al atacante inyectar IPs
 * arbitrarias y evadir rate-limit.
 */
export function getClientIp(req: NextRequest): string {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
        const first = xff.split(',')[0].trim();
        if (first) return first;
    }
    const realIp = req.headers.get('x-real-ip');
    if (realIp) return realIp.trim();
    return 'unknown';
}
