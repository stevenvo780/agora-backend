/**
 * POST /api/workspaces/[id]/retire-folder
 * Body: { folderPath: string }
 *
 * "Retirar de la nube": elimina una carpeta y todo su subárbol del store vivo
 * (Firestore docs + blobs MinIO) PERO con respaldo — los blobs se MUEVEN a un
 * prefijo `recycle/<wsId>/<ts>/` en el mismo bucket (almacenamiento VPS, sin
 * costo GCP) en vez de borrarse, así son recuperables. Los docs Firestore (el
 * costo medido) sí se borran. Deja un manifiesto en `workspaces/{id}/retired/{ts}`.
 *
 * Distinto de `.syncignore` (que solo detiene el sync sin borrar) y del DELETE
 * por-doc (que borra el blob de verdad). Pensado para retirar carpetas viejas
 * sin riesgo de pérdida.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';
import { isNasConfigured, copyObject, deleteObject } from '@/lib/nas-storage';
import { getErrorMessage } from '@/lib/error-utils';

type RouteContext = { params: Promise<{ id: string }> };

interface DocRow { id: string; ref: FirebaseFirestore.DocumentReference; storagePath: string | null }

export async function POST(req: NextRequest, context: RouteContext) {
    try {
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const { id: workspaceId } = await context.params;
        const body = (await req.json()) as { folderPath?: unknown };
        const folderPath = typeof body.folderPath === 'string' ? body.folderPath.replace(/^\/+|\/+$/g, '').trim() : '';
        if (!folderPath) return NextResponse.json({ error: 'folderPath requerido' }, { status: 400 });

        // ACL + dueño del store
        const personal = isPersonalWorkspaceId(workspaceId);
        let ownerUid = auth.uid;
        if (!personal) {
            const ws = await adminDb.collection('workspaces').doc(workspaceId).get();
            if (!ws.exists) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
            const data = ws.data() as { ownerId?: string; members?: string[] } | undefined;
            const ok = (data?.members ?? []).includes(auth.uid) || data?.ownerId === auth.uid || await isWorkspaceMember(workspaceId, auth.uid);
            if (!ok) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            ownerUid = data?.ownerId ?? auth.uid;
        }

        // Todos los docs del workspace; filtramos el subárbol en código (folder
        // es prefijo mutable, Firestore no hace startsWith).
        let q: FirebaseFirestore.Query = adminDb.collection('documents');
        q = personal
            ? q.where('ownerId', '==', auth.uid).where('workspaceId', '==', PERSONAL_WORKSPACE_ID)
            : q.where('workspaceId', '==', workspaceId);
        const snap = await q.get();

        const prefix = `${folderPath}/`;
        const targets: DocRow[] = [];
        for (const d of snap.docs) {
            const data = d.data() as { folder?: string; name?: string; type?: string; storagePath?: string };
            const folder = typeof data.folder === 'string' ? data.folder : '';
            const name = typeof data.name === 'string' ? data.name : '';
            const inSubtree = data.type === 'folder'
                ? (() => { const full = folder ? `${folder}/${name}` : name; return full === folderPath || full.startsWith(prefix); })()
                : (folder === folderPath || folder.startsWith(prefix));
            if (inSubtree) {
                targets.push({ id: d.id, ref: d.ref, storagePath: typeof data.storagePath === 'string' ? data.storagePath : null });
            }
        }

        if (targets.length === 0) return NextResponse.json({ error: 'No hay nada bajo esa carpeta', folderPath }, { status: 404 });

        const ts = Date.now();
        const recycleRoot = `recycle/${workspaceId}/${ts}`;
        const targetIds = new Set(targets.map(t => t.id));

        // Respaldo: mover cada blob al recycle (copy + delete). Guard de dedup:
        // si OTRO doc fuera del subárbol comparte el storagePath, no tocamos el
        // blob (lo necesita el gemelo) — solo borramos el doc. Un mismo
        // storagePath con varios docs internos se mueve una sola vez.
        let recycled = 0; let sharedKept = 0;
        const movedPaths = new Set<string>();
        if (isNasConfigured()) {
            for (const t of targets) {
                if (!t.storagePath || movedPaths.has(t.storagePath)) continue;
                const others = await adminDb.collection('documents')
                    .where('storagePath', '==', t.storagePath).limit(50).get();
                const externalRef = others.docs.some(o => !targetIds.has(o.id));
                if (externalRef) { sharedKept++; continue; }
                try {
                    await copyObject(t.storagePath, `${recycleRoot}/${t.storagePath}`);
                    await deleteObject(t.storagePath).catch(() => undefined);
                    movedPaths.add(t.storagePath);
                    recycled++;
                } catch (err) {
                    console.warn('[retire-folder] recycle move failed', t.storagePath, getErrorMessage(err));
                }
            }
        }

        // Manifiesto para referencia/restauración.
        await adminDb.collection('workspaces').doc(workspaceId).collection('retired').doc(String(ts)).set({
            folderPath, retiredAt: FieldValue.serverTimestamp(), by: auth.uid, ownerUid,
            docCount: targets.length, recycledBlobs: recycled, sharedBlobsKept: sharedKept,
            recyclePrefix: recycleRoot,
            paths: targets.map(t => t.storagePath).filter(Boolean).slice(0, 2000),
        });

        // Borrar los docs (batches de 400).
        let batch = adminDb.batch(); let n = 0; let deleted = 0;
        for (const t of targets) {
            batch.delete(t.ref); n++; deleted++;
            if (n >= 400) { await batch.commit(); batch = adminDb.batch(); n = 0; }
        }
        if (n > 0) await batch.commit();

        console.warn(`[retire-folder] ws=${workspaceId} path="${folderPath}" docs=${deleted} recycled=${recycled} sharedKept=${sharedKept} recycle=${recycleRoot}`);
        return NextResponse.json({
            ok: true, folderPath, retiredDocs: deleted, recycledBlobs: recycled,
            sharedBlobsKept: sharedKept, recyclePrefix: recycleRoot, backupId: String(ts),
        });
    } catch (e) {
        console.error('[retire-folder] error', getErrorMessage(e));
        return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
}
