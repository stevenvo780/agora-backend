import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, confirm,
  ensureBoardRef, loadBoardState, resolveBoardColumn, resolveBoardCard,
  fetchDocumentForUser,
  adminDb, FieldValue,
  normalizeFolderPath
} from './shared';
import { extractChecklistTasks } from '@/lib/agora-ai/documentIntelligence';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

async function getBoard(call: AgentToolCall, ctx: AgentExecutionContext) {
  const { boardRef, columns, cards } = await loadBoardState(ctx);
  return ok(call, `Recuperé el tablero con ${columns.length} columna(s) y ${cards.length} tarjeta(s).`, {
    board: {
      id: boardRef.id,
      columns: columns.map((column) => ({ id: column.id, name: column.name || 'Sin título', order: column.order || 0 })),
      cards: cards.map((card) => ({
        id: card.id,
        title: card.title || 'Sin título',
        description: card.description || '',
        columnId: card.columnId || '',
        order: card.order || 0,
        ownerId: card.ownerId || null,
        sourceDocId: card.sourceDocId || null,
        sourceDocName: card.sourceDocName || null,
        sourceFragment: card.sourceFragment || null,
        sourcePath: card.sourcePath || null
      }))
    }
  });
}

async function createBoardColumn(call: AgentToolCall, ctx: AgentExecutionContext) {
  const name = String(call.args.name || '').trim();
  if (!name) throw new Error('name es requerido');
  const { boardRef, columns } = await loadBoardState(ctx);
  const order = typeof call.args.order === 'number'
    ? call.args.order
    : (columns.reduce((max, column) => Math.max(max, column.order || 0), 0) + 1000);
  const ref = boardRef.collection('columns').doc();
  await ref.set({
    name,
    order,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });
  await boardRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return ok(call, `Creé la columna "${name}".`, {
    column: { id: ref.id, name, order }
  }, [{ action: 'delete_board_column', args: { columnId: ref.id, confirmed: true } }]);
}

async function renameBoardColumn(call: AgentToolCall, ctx: AgentExecutionContext) {
  const columnId = String(call.args.columnId || '').trim();
  const name = String(call.args.name || '').trim();
  if (!columnId || !name) throw new Error('columnId y name son requeridos');
  const boardRef = await ensureBoardRef(ctx);
  const column = await resolveBoardColumn(boardRef, columnId);
  await boardRef.collection('columns').doc(column.id).update({ name, updatedAt: FieldValue.serverTimestamp() });
  await boardRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return ok(call, `Renombré la columna "${column.name || 'Sin título'}" a "${name}".`, {
    column: { id: column.id, previousName: column.name || 'Sin título', name }
  }, [{ action: 'rename_board_column', args: { columnId: column.id, name: column.name || 'Sin título' } }]);
}

async function restoreBoardCard(call: AgentToolCall, ctx: AgentExecutionContext) {
  const snapshot = call.args.snapshot as Record<string, unknown> | undefined;
  if (!snapshot) throw new Error('snapshot es requerido');
  const boardRef = await ensureBoardRef(ctx);
  const explicitId = typeof call.args.cardId === 'string' ? call.args.cardId : boardRef.collection('cards').doc().id;
  await boardRef.collection('cards').doc(explicitId).set({
    title: snapshot.title || 'Sin título',
    description: snapshot.description || '',
    columnId: snapshot.columnId || '',
    order: snapshot.order || Date.now(),
    ownerId: snapshot.ownerId || ctx.uid,
    sourceDocId: snapshot.sourceDocId || null,
    sourceDocName: snapshot.sourceDocName || null,
    sourceFragment: snapshot.sourceFragment || null,
    sourcePath: snapshot.sourcePath || null,
    updatedAt: FieldValue.serverTimestamp(),
    restoredBy: ctx.uid
  }, { merge: true });
  await boardRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return ok(call, `Restauré la tarjeta "${String(snapshot.title || explicitId)}".`, { cardId: explicitId });
}

async function restoreBoardColumn(call: AgentToolCall, ctx: AgentExecutionContext) {
  const snapshot = call.args.snapshot as Record<string, unknown> | undefined;
  if (!snapshot) throw new Error('snapshot es requerido');
  const boardRef = await ensureBoardRef(ctx);
  const explicitId = typeof call.args.columnId === 'string' ? call.args.columnId : boardRef.collection('columns').doc().id;
  await boardRef.collection('columns').doc(explicitId).set({
    name: snapshot.name || 'Sin título',
    order: snapshot.order || 1000,
    updatedAt: FieldValue.serverTimestamp(),
    restoredBy: ctx.uid
  }, { merge: true });
  const cards = Array.isArray(snapshot.cards) ? snapshot.cards as Array<Record<string, unknown>> : [];
  for (const card of cards) {
    const cardId = typeof card.id === 'string' ? card.id : boardRef.collection('cards').doc().id;
    await boardRef.collection('cards').doc(cardId).set({
      title: card.title || 'Sin título',
      description: card.description || '',
      columnId: explicitId,
      order: card.order || Date.now(),
      ownerId: card.ownerId || ctx.uid,
      sourceDocId: card.sourceDocId || null,
      sourceDocName: card.sourceDocName || null,
      sourceFragment: card.sourceFragment || null,
      sourcePath: card.sourcePath || null,
      updatedAt: FieldValue.serverTimestamp(),
      restoredBy: ctx.uid
    }, { merge: true });
  }
  await boardRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return ok(call, `Restauré la columna "${String(snapshot.name || explicitId)}" con ${cards.length} tarjeta(s).`, { columnId: explicitId });
}

async function deleteBoardColumn(call: AgentToolCall, ctx: AgentExecutionContext) {
  const columnId = String(call.args.columnId || '').trim();
  const confirmed = call.args.confirmed === true;
  if (!columnId) throw new Error('columnId es requerido');
  const boardRef = await ensureBoardRef(ctx);
  const column = await resolveBoardColumn(boardRef, columnId);
  const cardsSnap = await boardRef.collection('cards').where('columnId', '==', column.id).get();
  const cards = cardsSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }));
  if (!confirmed) {
    return confirm(call, `¿Confirmas eliminar la columna "${column.name || 'Sin título'}" y ${cards.length} tarjeta(s)?`, {
      column: { id: column.id, name: column.name || 'Sin título', cardsCount: cards.length }
    });
  }
  const batch = adminDb.batch();
  batch.delete(boardRef.collection('columns').doc(column.id));
  cardsSnap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  await boardRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return ok(call, `Eliminé la columna "${column.name || 'Sin título'}" y ${cards.length} tarjeta(s).`, {
    column: { id: column.id, name: column.name || 'Sin título', cardsCount: cards.length }
  }, [{ action: 'restore_board_column', args: { columnId: column.id, snapshot: { name: column.name || 'Sin título', order: column.order || 0, cards } } }]);
}

async function createBoardCard(call: AgentToolCall, ctx: AgentExecutionContext) {
  const columnId = String(call.args.columnId || '').trim();
  const title = String(call.args.title || '').trim();
  if (!columnId || !title) throw new Error('columnId y title son requeridos');
  const boardRef = await ensureBoardRef(ctx);
  const column = await resolveBoardColumn(boardRef, columnId);
  const cardsSnap = await boardRef.collection('cards').where('columnId', '==', column.id).get();
  const order = cardsSnap.docs.reduce((max, doc) => Math.max(max, Number(doc.data().order || 0)), 0) + 1000;
  const ref = boardRef.collection('cards').doc();
  await ref.set({
    title,
    description: typeof call.args.description === 'string' ? call.args.description : '',
    columnId: column.id,
    order,
    ownerId: ctx.uid,
    sourceDocId: typeof call.args.sourceDocId === 'string' ? call.args.sourceDocId : null,
    sourceDocName: typeof call.args.sourceDocName === 'string' ? call.args.sourceDocName : null,
    sourceFragment: typeof call.args.sourceFragment === 'string' ? call.args.sourceFragment : null,
    sourcePath: typeof call.args.sourcePath === 'string' ? call.args.sourcePath : null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });
  await boardRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return ok(call, `Creé la tarjeta "${title}" en "${column.name || 'Sin título'}".`, {
    card: { id: ref.id, title, columnId: column.id, columnName: column.name || 'Sin título', order }
  }, [{ action: 'delete_board_card', args: { cardId: ref.id, confirmed: true } }]);
}

async function updateBoardCard(call: AgentToolCall, ctx: AgentExecutionContext) {
  const cardId = String(call.args.cardId || '').trim();
  if (!cardId) throw new Error('cardId es requerido');
  const boardRef = await ensureBoardRef(ctx);
  const card = await resolveBoardCard(boardRef, cardId);
  const previous = {
    title: card.title || 'Sin título',
    description: card.description || '',
    columnId: card.columnId || '',
    order: card.order || 0,
    ownerId: card.ownerId || ctx.uid,
    sourceDocId: card.sourceDocId || null,
    sourceDocName: card.sourceDocName || null,
    sourceFragment: card.sourceFragment || null,
    sourcePath: card.sourcePath || null
  };
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (typeof call.args.title === 'string') updates.title = call.args.title.trim() || previous.title;
  if (typeof call.args.description === 'string') updates.description = call.args.description;
  if (typeof call.args.order === 'number') updates.order = call.args.order;
  if (typeof call.args.columnId === 'string' && call.args.columnId.trim()) {
    const column = await resolveBoardColumn(boardRef, call.args.columnId.trim());
    updates.columnId = column.id;
  }
  if (Object.keys(updates).length === 1) throw new Error('No hay cambios para aplicar a la tarjeta');
  await boardRef.collection('cards').doc(card.id).update(updates);
  await boardRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return ok(call, `Actualicé la tarjeta "${updates.title || previous.title}".`, {
    card: { id: card.id, ...previous, ...updates }
  }, [{ action: 'update_board_card', args: { cardId: card.id, ...previous } }]);
}

async function moveBoardCard(call: AgentToolCall, ctx: AgentExecutionContext) {
  const cardId = String(call.args.cardId || '').trim();
  const targetColumnId = String(call.args.targetColumnId || '').trim();
  if (!cardId || !targetColumnId) throw new Error('cardId y targetColumnId son requeridos');
  const boardRef = await ensureBoardRef(ctx);
  const card = await resolveBoardCard(boardRef, cardId);
  const targetColumn = await resolveBoardColumn(boardRef, targetColumnId);
  const cardsSnap = await boardRef.collection('cards').where('columnId', '==', targetColumn.id).get();
  const order = typeof call.args.order === 'number'
    ? call.args.order
    : cardsSnap.docs.reduce((max, doc) => Math.max(max, Number(doc.data().order || 0)), 0) + 1000;
  await boardRef.collection('cards').doc(card.id).update({
    columnId: targetColumn.id,
    order,
    updatedAt: FieldValue.serverTimestamp()
  });
  await boardRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return ok(call, `Moví la tarjeta "${card.title || 'Sin título'}" a "${targetColumn.name || 'Sin título'}".`, {
    card: {
      id: card.id,
      title: card.title || 'Sin título',
      previousColumnId: card.columnId || '',
      columnId: targetColumn.id,
      columnName: targetColumn.name || 'Sin título',
      order
    }
  }, [{ action: 'update_board_card', args: { cardId: card.id, columnId: card.columnId || '', order: card.order || 0 } }]);
}

async function deleteBoardCard(call: AgentToolCall, ctx: AgentExecutionContext) {
  const cardId = String(call.args.cardId || '').trim();
  const confirmed = call.args.confirmed === true;
  if (!cardId) throw new Error('cardId es requerido');
  const boardRef = await ensureBoardRef(ctx);
  const card = await resolveBoardCard(boardRef, cardId);
  if (!confirmed) {
    return confirm(call, `¿Confirmas eliminar la tarjeta "${card.title || 'Sin título'}"?`, {
      card: { id: card.id, title: card.title || 'Sin título', columnId: card.columnId || '' }
    });
  }
  const snapshot = {
    title: card.title || 'Sin título',
    description: card.description || '',
    columnId: card.columnId || '',
    order: card.order || 0,
    ownerId: card.ownerId || ctx.uid,
    sourceDocId: card.sourceDocId || null,
    sourceDocName: card.sourceDocName || null,
    sourceFragment: card.sourceFragment || null,
    sourcePath: card.sourcePath || null
  };
  await boardRef.collection('cards').doc(card.id).delete();
  await boardRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return ok(call, `Eliminé la tarjeta "${card.title || 'Sin título'}".`, {
    card: { id: card.id, title: card.title || 'Sin título' }
  }, [{ action: 'restore_board_card', args: { cardId: card.id, snapshot } }]);
}

async function extractPendingTasks(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);
  const tasks = extractChecklistTasks(doc.content || '');
  const createCards = call.args.createCards === true;
  if (!createCards || tasks.length === 0) {
    return ok(call, `Extraje ${tasks.length} pendiente(s) de "${doc.name || 'Sin título'}".`, {
      document: { id: doc.id, name: doc.name || 'Sin título' },
      tasks
    });
  }

  const { boardRef, columns } = await loadBoardState(ctx);
  const targetColumn = typeof call.args.targetColumnId === 'string' && call.args.targetColumnId.trim()
    ? await resolveBoardColumn(boardRef, call.args.targetColumnId.trim())
    : (columns.find((column) => /por hacer|backlog|todo/i.test(String(column.name || ''))) || columns[0]);
  if (!targetColumn) throw new Error('No hay columnas disponibles en el tablero');

  const createdCards: Array<{ id: string; title: string }> = [];
  let maxOrder = (await boardRef.collection('cards').where('columnId', '==', targetColumn.id).get())
    .docs.reduce((max, item) => Math.max(max, Number(item.data().order || 0)), 0);
  for (const task of tasks) {
    maxOrder += 1000;
    const ref = boardRef.collection('cards').doc();
    await ref.set({
      title: task,
      description: `Pendiente extraído desde ${doc.name || 'documento'}`,
      columnId: targetColumn.id,
      order: maxOrder,
      ownerId: ctx.uid,
      sourceDocId: doc.id,
      sourceDocName: doc.name || 'Sin título',
      sourceFragment: task,
      sourcePath: normalizeFolderPath(doc.folder),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    createdCards.push({ id: ref.id, title: task });
  }
  await boardRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  return ok(call, `Extraje ${tasks.length} pendiente(s) y creé ${createdCards.length} tarjeta(s) en "${targetColumn.name || 'Sin título'}".`, {
    document: { id: doc.id, name: doc.name || 'Sin título' },
    tasks,
    createdCards,
    targetColumn: { id: targetColumn.id, name: targetColumn.name || 'Sin título' }
  }, createdCards.map((card) => ({ action: 'delete_board_card', args: { cardId: card.id, confirmed: true } })));
}

export const BOARD_TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_board: getBoard,
  create_board_column: createBoardColumn,
  rename_board_column: renameBoardColumn,
  delete_board_column: deleteBoardColumn,
  create_board_card: createBoardCard,
  update_board_card: updateBoardCard,
  move_board_card: moveBoardCard,
  delete_board_card: deleteBoardCard,
  restore_board_card: restoreBoardCard,
  restore_board_column: restoreBoardColumn,
  extract_pending_tasks: extractPendingTasks
};
