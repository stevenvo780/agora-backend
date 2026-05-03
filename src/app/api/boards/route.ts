import { env } from '@/lib/env';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue, type CollectionReference, type DocumentReference, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import type { BoardCard, BoardColumn } from '@/types/boards';
import { getErrorMessage } from '@/lib/error-utils';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';

const DEFAULT_COLUMNS = ['Por hacer', 'En progreso', 'Hecho'];

enum BoardEntityType {
  Column = 'column',
  Card = 'card'
}

interface MockBoardColumn extends BoardColumn {
  createdAt: number;
  updatedAt: number;
}

interface MockBoardCard extends BoardCard {
  createdAt: number;
  updatedAt: number;
}

interface MockBoardState {
  columns: MockBoardColumn[];
  cards: MockBoardCard[];
  seq: number;
}

// Simple in-memory mock board for insecure/dev mode to avoid hitting Firestore
const mockBoards = new Map<string, MockBoardState>();

const getMockBoard = (workspaceId: string) => {
  if (!mockBoards.has(workspaceId)) {
    const baseColumns = DEFAULT_COLUMNS.map((name, index) => ({
      id: `mock-col-${index + 1}`,
      name,
      order: (index + 1) * 1000,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }));
    mockBoards.set(workspaceId, { columns: baseColumns, cards: [], seq: 1 });
  }
  return mockBoards.get(workspaceId)!;
};

const resolveWorkspaceId = (workspaceId: string, uid: string) =>
  isPersonalWorkspaceId(workspaceId) ? `${PERSONAL_WORKSPACE_ID}:${uid}` : workspaceId;

const canAccessWorkspace = async (workspaceId: string, uid: string) => {
  if (isPersonalWorkspaceId(workspaceId)) return true;
  return isWorkspaceMember(workspaceId, uid);
};

const ensureBoard = async (workspaceId: string) => {
  const boardRef = adminDb.collection('boards').doc(workspaceId);
  const snap = await boardRef.get();
  if (!snap.exists) {
    await boardRef.set({
      workspaceId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
  }
  return boardRef;
};

const seedDefaultColumns = async (columnsRef: CollectionReference) => {
  const batch = adminDb.batch();
  DEFAULT_COLUMNS.forEach((name, index) => {
    const ref = columnsRef.doc();
    batch.set(ref, {
      name,
      order: (index + 1) * 1000,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
  });
  await batch.commit();
};

const touchBoard = (boardRef: DocumentReference) => {
  return boardRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
};

const deleteCardsByColumn = async (boardRef: DocumentReference, columnId: string) => {
  const batchLimit = 400;
  let lastDoc: QueryDocumentSnapshot | null = null;

  while (true) {
    let query = boardRef
      .collection('cards')
      .where('columnId', '==', columnId)
      .orderBy('__name__')
      .limit(batchLimit);

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) break;

    const batch = adminDb.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    if (snapshot.size < batchLimit) break;
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
  }
};

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const workspaceId = searchParams.get('workspaceId');

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const allowed = await canAccessWorkspace(workspaceId, auth.uid);
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (env.ALLOW_INSECURE_AUTH()) {
      const resolvedWorkspaceId = resolveWorkspaceId(workspaceId, auth.uid);
      const mock = getMockBoard(resolvedWorkspaceId);
      return NextResponse.json({
        boardId: `${resolvedWorkspaceId}-mock`,
        workspaceId,
        columns: mock.columns,
        cards: mock.cards
      });
    }

    const resolvedWorkspaceId = resolveWorkspaceId(workspaceId, auth.uid);
    const boardRef = await ensureBoard(resolvedWorkspaceId);
    const columnsRef = boardRef.collection('columns');

    let columnsSnap = await columnsRef.orderBy('order').get();
    if (columnsSnap.empty) {
      await seedDefaultColumns(columnsRef);
      columnsSnap = await columnsRef.orderBy('order').get();
    }

    const columns = columnsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const cardsSnap = await boardRef.collection('cards').orderBy('order').get();
    const cards = cardsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    return NextResponse.json({
      boardId: boardRef.id,
      workspaceId,
      columns,
      cards
    });
  } catch (error: unknown) {
    console.error('Error fetching board:', error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const body = await req.json();
    const { workspaceId, type } = body as { workspaceId?: string; type?: string };

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const allowed = await canAccessWorkspace(workspaceId, auth.uid);
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (env.ALLOW_INSECURE_AUTH()) {
      const resolvedWorkspaceId = resolveWorkspaceId(workspaceId, auth.uid);
      const mock = getMockBoard(resolvedWorkspaceId);

      if (type === BoardEntityType.Column) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const column = {
          id: `mock-col-${++mock.seq}`,
          name: name || 'Sin titulo',
          order: typeof body.order === 'number' ? body.order : Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        mock.columns.push(column);
        return NextResponse.json(column);
      }

      if (type === BoardEntityType.Card) {
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const columnId = typeof body.columnId === 'string' ? body.columnId.trim() : '';
        if (!columnId) {
          return NextResponse.json({ error: 'columnId is required' }, { status: 400 });
        }
        const card = {
          id: `mock-card-${++mock.seq}`,
          title: title || 'Nueva tarjeta',
          description: typeof body.description === 'string' ? body.description : undefined,
          columnId,
          order: typeof body.order === 'number' ? body.order : Date.now(),
          ownerId: auth.uid,
          sourceDocId: typeof body.sourceDocId === 'string' ? body.sourceDocId : null,
          sourceDocName: typeof body.sourceDocName === 'string' ? body.sourceDocName : null,
          sourceFragment: typeof body.sourceFragment === 'string' ? body.sourceFragment : null,
          sourcePath: typeof body.sourcePath === 'string' ? body.sourcePath : null,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        mock.cards.push(card);
        return NextResponse.json(card);
      }

      return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
    }

    const resolvedWorkspaceId = resolveWorkspaceId(workspaceId, auth.uid);
    const boardRef = await ensureBoard(resolvedWorkspaceId);

    if (type === BoardEntityType.Column) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const columnRef = boardRef.collection('columns').doc();
      const data = {
        name: name || 'Sin titulo',
        order: typeof body.order === 'number' ? body.order : Date.now(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };
      await columnRef.set(data);
      await touchBoard(boardRef);
      const snap = await columnRef.get();
      return NextResponse.json({ id: columnRef.id, ...snap.data() });
    }

    if (type === BoardEntityType.Card) {
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const columnId = typeof body.columnId === 'string' ? body.columnId.trim() : '';
      if (!columnId) {
        return NextResponse.json({ error: 'columnId is required' }, { status: 400 });
      }
      const cardRef = boardRef.collection('cards').doc();
      const data = {
        title: title || 'Nueva tarjeta',
        description: typeof body.description === 'string' ? body.description : undefined,
        columnId,
        order: typeof body.order === 'number' ? body.order : Date.now(),
        ownerId: auth.uid,
        sourceDocId: typeof body.sourceDocId === 'string' ? body.sourceDocId : null,
        sourceDocName: typeof body.sourceDocName === 'string' ? body.sourceDocName : null,
        sourceFragment: typeof body.sourceFragment === 'string' ? body.sourceFragment : null,
        sourcePath: typeof body.sourcePath === 'string' ? body.sourcePath : null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };
      await cardRef.set(data);
      await touchBoard(boardRef);
      const snap = await cardRef.get();
      return NextResponse.json({ id: cardRef.id, ...snap.data() });
    }

    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  } catch (error: unknown) {
    console.error('Error creating board item:', error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const body = await req.json();
    const { workspaceId, type, id, data } = body as {
      workspaceId?: string;
      type?: string;
      id?: string;
      data?: Record<string, unknown>;
    };

    if (!workspaceId || !id) {
      return NextResponse.json({ error: 'workspaceId and id are required' }, { status: 400 });
    }

    const allowed = await canAccessWorkspace(workspaceId, auth.uid);
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (env.ALLOW_INSECURE_AUTH()) {
      const resolvedWorkspaceId = resolveWorkspaceId(workspaceId, auth.uid);
      const mock = getMockBoard(resolvedWorkspaceId);

      if (type === BoardEntityType.Column) {
        const column = mock.columns.find(c => c.id === id);
        if (!column) return NextResponse.json({ error: 'Column not found' }, { status: 404 });
        if (typeof data?.name === 'string') column.name = data.name.trim();
        if (typeof data?.order === 'number') column.order = data.order;
        column.updatedAt = Date.now();
        return NextResponse.json({ status: 'updated' });
      }

      if (type === BoardEntityType.Card) {
        const card = mock.cards.find(c => c.id === id);
        if (!card) return NextResponse.json({ error: 'Card not found' }, { status: 404 });
        if (typeof data?.title === 'string') card.title = data.title.trim();
        if (typeof data?.description === 'string') card.description = data.description;
        if (typeof data?.columnId === 'string') card.columnId = data.columnId.trim();
        if (typeof data?.order === 'number') card.order = data.order;
        if (typeof data?.sourceDocId === 'string') card.sourceDocId = data.sourceDocId;
        if (typeof data?.sourceDocName === 'string') card.sourceDocName = data.sourceDocName;
        if (typeof data?.sourceFragment === 'string') card.sourceFragment = data.sourceFragment;
        if (typeof data?.sourcePath === 'string') card.sourcePath = data.sourcePath;
        card.updatedAt = Date.now();
        return NextResponse.json({ status: 'updated' });
      }

      return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
    }

    const resolvedWorkspaceId = resolveWorkspaceId(workspaceId, auth.uid);
    const boardRef = await ensureBoard(resolvedWorkspaceId);
    const updateData: Record<string, unknown> = {};

    if (type === BoardEntityType.Column) {
      if (typeof data?.name === 'string') updateData.name = data.name.trim();
      if (typeof data?.order === 'number') updateData.order = data.order;
      if (Object.keys(updateData).length === 0) {
        return NextResponse.json({ error: 'No data to update' }, { status: 400 });
      }
      updateData.updatedAt = FieldValue.serverTimestamp();
      await boardRef.collection('columns').doc(id).update(updateData);
      await touchBoard(boardRef);
      return NextResponse.json({ status: 'updated' });
    }

    if (type === BoardEntityType.Card) {
      if (typeof data?.title === 'string') updateData.title = data.title.trim();
      if (typeof data?.description === 'string') updateData.description = data.description;
      if (typeof data?.columnId === 'string') updateData.columnId = data.columnId.trim();
      if (typeof data?.order === 'number') updateData.order = data.order;
      if (typeof data?.sourceDocId === 'string') updateData.sourceDocId = data.sourceDocId;
      if (typeof data?.sourceDocName === 'string') updateData.sourceDocName = data.sourceDocName;
      if (typeof data?.sourceFragment === 'string') updateData.sourceFragment = data.sourceFragment;
      if (typeof data?.sourcePath === 'string') updateData.sourcePath = data.sourcePath;
      if (Object.keys(updateData).length === 0) {
        return NextResponse.json({ error: 'No data to update' }, { status: 400 });
      }
      updateData.updatedAt = FieldValue.serverTimestamp();
      await boardRef.collection('cards').doc(id).update(updateData);
      await touchBoard(boardRef);
      return NextResponse.json({ status: 'updated' });
    }

    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  } catch (error: unknown) {
    console.error('Error updating board item:', error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const body = await req.json();
    const { workspaceId, type, id } = body as { workspaceId?: string; type?: string; id?: string };

    if (!workspaceId || !id) {
      return NextResponse.json({ error: 'workspaceId and id are required' }, { status: 400 });
    }

    const allowed = await canAccessWorkspace(workspaceId, auth.uid);
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (env.ALLOW_INSECURE_AUTH()) {
      const resolvedWorkspaceId = resolveWorkspaceId(workspaceId, auth.uid);
      const mock = getMockBoard(resolvedWorkspaceId);

      if (type === BoardEntityType.Column) {
        mock.columns = mock.columns.filter(c => c.id !== id);
        mock.cards = mock.cards.filter(c => c.columnId !== id);
        return NextResponse.json({ status: 'deleted' });
      }

      if (type === BoardEntityType.Card) {
        mock.cards = mock.cards.filter(c => c.id !== id);
        return NextResponse.json({ status: 'deleted' });
      }

      return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
    }

    const resolvedWorkspaceId = resolveWorkspaceId(workspaceId, auth.uid);
    const boardRef = await ensureBoard(resolvedWorkspaceId);

    if (type === BoardEntityType.Column) {
      await deleteCardsByColumn(boardRef, id);
      await boardRef.collection('columns').doc(id).delete();
      await touchBoard(boardRef);
      return NextResponse.json({ status: 'deleted' });
    }

    if (type === BoardEntityType.Card) {
      await boardRef.collection('cards').doc(id).delete();
      await touchBoard(boardRef);
      return NextResponse.json({ status: 'deleted' });
    }

    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  } catch (error: unknown) {
    console.error('Error deleting board item:', error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
