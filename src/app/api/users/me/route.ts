import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { requireAuth, getUserRole } from '@/lib/server-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const role = await getUserRole(auth.uid);

    return NextResponse.json({
      uid: auth.uid,
      email: auth.email ?? null,
      role: role ?? 'user'
    });
  } catch (error: unknown) {
    console.error('Error fetching current user:', getErrorMessage(error));
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
