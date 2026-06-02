import type { NextRequest } from './next-server';
import { NextResponse } from './next-server';

type PlainObject = Record<string, unknown>;

/**
 * Parsea el cuerpo JSON de una Request y devuelve el objeto o una Response 400.
 *
 * Retorna `{ ok: true, value }` con el objeto plano, o
 * `{ ok: false, response }` con un NextResponse 400 listo para retornar.
 *
 * Rechaza: JSON sintácticamente inválido, body vacío/null, arrays y
 * primitivos — cualquier valor que no sea un objeto plano `{}`.
 */
export async function readJsonBody(
    req: NextRequest
): Promise<{ ok: true; value: PlainObject } | { ok: false; response: Response }> {
    let raw: unknown;
    try {
        raw = await req.json();
    } catch {
        return {
            ok: false,
            response: NextResponse.json({ error: 'Cuerpo JSON inválido' }, { status: 400 })
        };
    }

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return {
            ok: false,
            response: NextResponse.json({ error: 'Cuerpo JSON inválido' }, { status: 400 })
        };
    }

    return { ok: true, value: raw as PlainObject };
}
