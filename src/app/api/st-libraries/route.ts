/**
 * /api/st-libraries — GET (list filtrado por visibility) y POST (create).
 * Auth Firebase. Libraries viven en Firestore `stLibraries`.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { requireAuth } from '@/lib/server-auth';
import {
  createLibrary,
  filterReadableLibraries,
  isLibraryVisibility,
  listLibraries,
  parseLibraryCreateInput,
  type LibraryListFilter
} from '@/lib/cloud-libraries';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const params = req.nextUrl.searchParams;
    const filter: LibraryListFilter = {};
    const ownerUid = params.get('owner');
    if (ownerUid) filter.ownerUid = ownerUid;
    const visibility = params.get('visibility');
    if (visibility && isLibraryVisibility(visibility)) filter.visibility = visibility;
    const profile = params.get('profile');
    if (profile) filter.profile = profile;
    const tag = params.get('tag');
    if (tag) filter.tag = tag;
    const limitRaw = params.get('limit');
    if (limitRaw) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (Number.isFinite(parsed)) filter.limit = parsed;
    }

    const requesterWorkspaceId = params.get('workspaceId') || undefined;
    const requester = { uid: auth.uid, workspaceId: requesterWorkspaceId };

    const all = await listLibraries(filter);
    const visible = filterReadableLibraries(all, requester);
    return NextResponse.json({ items: visible });
  } catch (error) {
    console.error('GET /api/st-libraries error', getErrorMessage(error));
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const body = await req.json().catch(() => null);
    const parsed = parseLibraryCreateInput(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    if (parsed.value.owner.uid !== auth.uid) {
      return NextResponse.json({ error: 'owner.uid debe coincidir con el caller' }, { status: 403 });
    }

    const library = await createLibrary(parsed.value);
    return NextResponse.json(library, { status: 201 });
  } catch (error) {
    console.error('POST /api/st-libraries error', getErrorMessage(error));
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
