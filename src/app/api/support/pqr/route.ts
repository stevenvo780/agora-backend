import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { checkAuthRateLimit, recordAuthAttempt } from '@/lib/auth-rate-limit';
import { getErrorMessage } from '@/lib/error-utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PQR_WINDOW_MS = 60 * 60 * 1000; // 1 hora
const MAX_PQR_ATTEMPTS = 5;

const VALID_TIPOS = ['peticion', 'queja', 'reclamo', 'sugerencia'] as const;
type TipoPQR = (typeof VALID_TIPOS)[number];

function isTipoPQR(value: unknown): value is TipoPQR {
  return typeof value === 'string' && (VALID_TIPOS as readonly string[]).includes(value);
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const limitKey = `pqr:${ip}`;
    const limitOptions = { windowMs: PQR_WINDOW_MS, maxAttempts: MAX_PQR_ATTEMPTS };

    const limit = await checkAuthRateLimit(limitKey, limitOptions);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Demasiadas solicitudes. Intenta de nuevo más tarde.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Cuerpo JSON inválido' }, { status: 400 });
    }

    const nombre = typeof body.nombre === 'string' ? body.nombre.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const tipo = body.tipo;
    const mensaje = typeof body.mensaje === 'string' ? body.mensaje.trim() : '';

    if (!nombre) {
      return NextResponse.json({ error: 'El nombre es requerido' }, { status: 400 });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Se requiere un email válido' }, { status: 400 });
    }
    if (!isTipoPQR(tipo)) {
      return NextResponse.json(
        { error: 'El tipo debe ser: peticion, queja, reclamo o sugerencia' },
        { status: 400 }
      );
    }
    if (!mensaje || mensaje.length < 10) {
      return NextResponse.json(
        { error: 'El mensaje debe tener al menos 10 caracteres' },
        { status: 400 }
      );
    }
    if (mensaje.length > 5000) {
      return NextResponse.json(
        { error: 'El mensaje no puede superar los 5000 caracteres' },
        { status: 400 }
      );
    }

    await recordAuthAttempt(limitKey, limitOptions);

    const docRef = adminDb.collection('supportTickets').doc();
    const ticketId = docRef.id;

    await docRef.set({
      ticketId,
      nombre,
      email,
      tipo,
      mensaje,
      estado: 'nuevo',
      ip,
      createdAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ ok: true, ticketId }, { status: 201 });
  } catch (error: unknown) {
    console.error('[support/pqr] Error al guardar ticket:', getErrorMessage(error));
    return NextResponse.json({ error: 'No se pudo registrar la solicitud. Intenta de nuevo.' }, { status: 500 });
  }
}
