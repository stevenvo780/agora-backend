import crypto from 'node:crypto';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireAuth } from '@/lib/server-auth';
import { readJsonBody } from '@/lib/http/read-json-body';
import { getErrorMessage } from '@/lib/error-utils';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PAT_PREFIX = 'agora_pat_';
const COLLECTION = 'cliTokens';

function generatePat(): { token: string; hash: string } {
  const bytes = crypto.randomBytes(32).toString('hex');
  const token = `${PAT_PREFIX}${bytes}`;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const snap = await adminDb
      .collection(COLLECTION)
      .where('uid', '==', auth.uid)
      .orderBy('createdAt', 'desc')
      .get();

    const tokens = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        name: typeof d['name'] === 'string' ? d['name'] : null,
        createdAt: d['createdAt'] instanceof Object && 'toDate' in d['createdAt']
          ? (d['createdAt'] as { toDate(): Date }).toDate().toISOString()
          : null,
        lastUsedAt: d['lastUsedAt'] instanceof Object && 'toDate' in d['lastUsedAt']
          ? (d['lastUsedAt'] as { toDate(): Date }).toDate().toISOString()
          : null,
        revoked: d['revoked'] === true,
      };
    });

    return NextResponse.json({ tokens });
  } catch (err) {
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const bodyResult = await readJsonBody(req);
    if (!bodyResult.ok) return bodyResult.response;

    const rawName = bodyResult.value['name'];
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 100) : null;

    const { token, hash } = generatePat();

    await adminDb.collection(COLLECTION).doc(hash).set({
      uid: auth.uid,
      name,
      createdAt: FieldValue.serverTimestamp(),
      lastUsedAt: null,
      revoked: false,
    });

    return NextResponse.json({ token, id: hash, name });
  } catch (err) {
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 });
  }
}
