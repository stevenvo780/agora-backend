import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, clamp, excerpt,
  ensureWorkspaceAccess, listWorkspaceSnippets, fetchSnippetForUser,
  adminDb, FieldValue, isPersonalWorkspaceId
} from './shared';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

async function listSnippets(call: AgentToolCall, ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  let query: FirebaseFirestore.Query = adminDb.collection('snippets')
    .where('workspaceId', '==', ctx.workspaceId);
  if (isPersonalWorkspaceId(ctx.workspaceId)) {
    query = query.where('ownerId', '==', ctx.uid);
  }
  const snap = await query.limit(100).get();

  const snippets = snap.docs.map(doc => {
    const data = doc.data() as Record<string, unknown>;
    return {
      id: doc.id,
      title: String(data.title || 'Sin título'),
      description: String(data.description || ''),
      category: String(data.category || 'general')
    };
  });

  return ok(call, `Encontré ${snippets.length} snippet(s).`, { snippets });
}

async function createSnippet(call: AgentToolCall, ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const title = String(call.args.title || '').trim();
  const markdown = typeof call.args.markdown === 'string' ? call.args.markdown : '';
  if (!title || !markdown) throw new Error('title y markdown son requeridos');

  const data = {
    title,
    markdown,
    description: typeof call.args.description === 'string' ? call.args.description.trim() : '',
    category: typeof call.args.category === 'string' ? call.args.category.trim() : 'general',
    workspaceId: ctx.workspaceId,
    ownerId: ctx.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    order: 0
  };

  const ref = await adminDb.collection('snippets').add(data);

  return ok(call, `Creé el snippet "${title}".`, {
    snippet: { id: ref.id, title, category: data.category }
  }, [{ action: 'delete_snippet', args: { snippetId: ref.id } }]);
}

async function deleteSnippet(call: AgentToolCall, ctx: AgentExecutionContext) {
  const snippetId = String(call.args.snippetId || '').trim();
  if (!snippetId) throw new Error('snippetId es requerido');
  const snippet = await fetchSnippetForUser(snippetId, ctx);
  const ref = adminDb.collection('snippets').doc(snippet.id);
  await ref.delete();
  return ok(call, `Eliminé el snippet "${String(snippet.title || snippetId)}".`, { snippetId: snippet.id }, [{
    action: 'create_snippet',
    args: {
      title: snippet.title || 'Sin título',
      markdown: snippet.markdown || '',
      description: snippet.description || '',
      category: snippet.category || 'general'
    }
  }]);
}

async function readSnippet(call: AgentToolCall, ctx: AgentExecutionContext) {
  const snippetId = String(call.args.snippetId || '').trim();
  if (!snippetId) throw new Error('snippetId es requerido');
  const snippet = await fetchSnippetForUser(snippetId, ctx);
  return ok(call, `Leí el snippet "${snippet.title || 'Sin título'}".`, {
    snippet: {
      id: snippet.id,
      title: snippet.title || 'Sin título',
      description: snippet.description || '',
      markdown: snippet.markdown || '',
      category: snippet.category || 'general',
      order: snippet.order || 0
    }
  });
}

async function searchSnippets(call: AgentToolCall, ctx: AgentExecutionContext) {
  const queryText = String(call.args.query || '').trim().toLowerCase();
  if (!queryText) throw new Error('query es requerido');
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 10, 1, 25);
  const snippets = await listWorkspaceSnippets(ctx);
  const results = snippets
    .filter((snippet) => [snippet.title, snippet.description, snippet.category, snippet.markdown]
      .map((value) => String(value || '').toLowerCase())
      .join('\n')
      .includes(queryText))
    .slice(0, limit)
    .map((snippet) => ({
      id: snippet.id,
      title: snippet.title || 'Sin título',
      description: snippet.description || '',
      category: snippet.category || 'general',
      preview: excerpt(snippet.markdown || '', 180)
    }));
  return ok(call, `La búsqueda devolvió ${results.length} snippet(s).`, { results });
}

async function updateSnippet(call: AgentToolCall, ctx: AgentExecutionContext) {
  const snippetId = String(call.args.snippetId || '').trim();
  if (!snippetId) throw new Error('snippetId es requerido');
  const snippet = await fetchSnippetForUser(snippetId, ctx);
  const previous = {
    title: snippet.title || 'Sin título',
    description: snippet.description || '',
    markdown: snippet.markdown || '',
    category: snippet.category || 'general',
    order: snippet.order || 0,
    workspaceId: snippet.workspaceId || ctx.workspaceId,
    ownerId: snippet.ownerId || ctx.uid
  };
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (typeof call.args.title === 'string') updates.title = call.args.title.trim() || previous.title;
  if (typeof call.args.description === 'string') updates.description = call.args.description.trim();
  if (typeof call.args.markdown === 'string') updates.markdown = call.args.markdown;
  if (typeof call.args.category === 'string') updates.category = call.args.category.trim() || previous.category;
  if (typeof call.args.order === 'number') updates.order = call.args.order;
  if (Object.keys(updates).length === 1) throw new Error('No hay cambios para aplicar al snippet');
  await adminDb.collection('snippets').doc(snippet.id).update(updates);
  return ok(call, `Actualicé el snippet "${updates.title || previous.title}".`, {
    snippet: { id: snippet.id, ...previous, ...updates }
  }, [{ action: 'update_snippet', args: { snippetId: snippet.id, ...previous } }]);
}

export const SNIPPET_TOOL_HANDLERS: Record<string, ToolHandler> = {
  list_snippets: listSnippets,
  create_snippet: createSnippet,
  read_snippet: readSnippet,
  search_snippets: searchSnippets,
  update_snippet: updateSnippet,
  delete_snippet: deleteSnippet
};
