import type { NextRequest } from './next-server';

export function getClientIp(req: NextRequest): string {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
        const last = xff.split(',').at(-1)?.trim();
        if (last) return last;
    }
    const realIp = req.headers.get('x-real-ip');
    if (realIp) return realIp.trim();
    return 'unknown';
}
