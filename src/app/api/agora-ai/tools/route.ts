/**
 * /api/agora-ai/tools
 *
 * Workspace tools for AgoraAIChat / Agora Agent.
 * GET  ?action=list_files|read_file|list_folders|get_workspace_info|get_semantic_state|list_snippets
 * POST { action, workspaceId, … }   — write and advanced actions, enforced server-side.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember, getTokenFromRequest } from '@/lib/server-auth';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { executeAgentTool } from '@/lib/agora-ai/toolExecutor';
import type { AgentAccessPolicy } from '@/lib/agora-ai/types';

export const maxDuration = 60;

async function verifyAccess(request: NextRequest, workspaceId: string) {
  const auth = await requireAuth(request);
  if (!auth) return null;
  if (!isPersonalWorkspaceId(workspaceId)) {
    const ok = await isWorkspaceMember(workspaceId, auth.uid);
    if (!ok) return null;
  }
  return auth;
}

const buildCall = (action: string, args: Record<string, unknown>) => ({
  id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  name: action,
  args
});

const actionAliases: Record<string, string> = {
  list_files: 'list_documents',
  read_file: 'read_document',
  create_file: 'create_document',
  rename_file: 'rename_document',
  delete_file: 'delete_document'
};

const normalizeAction = (action: string) => actionAliases[action] || action;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get('workspaceId') ?? '';
  const action = searchParams.get('action') ?? '';

  if (!workspaceId) return NextResponse.json({ error: 'workspaceId requerido' }, { status: 400 });

  const auth = await verifyAccess(request, workspaceId);
  if (!auth) return NextResponse.json({ error: 'Sin acceso al workspace' }, { status: 403 });

  try {
    const normalizedAction = normalizeAction(action);
    const args: Record<string, unknown> = {};

    if (normalizedAction === 'read_document') {
      const id = searchParams.get('id') ?? searchParams.get('documentId') ?? '';
      if (!id) return NextResponse.json({ error: 'id/documentId requerido' }, { status: 400 });
      args.documentId = id;
    }

    if (normalizedAction === 'list_documents') {
      const folder = searchParams.get('folder');
      const type = searchParams.get('type');
      const limit = searchParams.get('limit');
      if (folder) args.folder = folder;
      if (type) args.type = type;
      if (limit) args.limit = Number(limit);
    }

    if (normalizedAction === 'search_documents') {
      const query = searchParams.get('query') ?? '';
      if (!query) return NextResponse.json({ error: 'query requerido' }, { status: 400 });
      args.query = query;
      const limit = searchParams.get('limit');
      if (limit) args.limit = Number(limit);
    }

    const result = await executeAgentTool(buildCall(normalizedAction, args), {
      workspaceId,
      uid: auth.uid,
      email: auth.email,
      origin: request.nextUrl.origin,
      authToken: getTokenFromRequest(request) ?? undefined
    });

    const status = result.ok ? 200 : 500;
    return NextResponse.json(result, { status });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json() as {
    action?: string;
    workspaceId?: string;
    id?: string;
    title?: string;
    content?: string;
    newTitle?: string;
    targetFolder?: string;
    query?: string;
    limit?: number;
    type?: string;
    folder?: string;
    name?: string;
    parentFolder?: string;
    markdown?: string;
    description?: string;
    category?: string;
    documentId?: string;
    confirmed?: boolean;
    text?: string;
    profile?: string;
    language?: 'es' | 'en';
    snapshot?: Record<string, unknown>;
    snippetId?: string;
    llmEndpoint?: string;
    llmModel?: string;
    command?: string;
    cwd?: string;
    timeoutMs?: number;
    maxOutputChars?: number;
    expectChanges?: boolean;
    reason?: string;
    documentIds?: string[];
    path?: string;
    maxDepth?: number;
    message?: string;
    panel?: string;
    severity?: 'error' | 'warning' | 'info' | 'hint';
    code?: string;
    includeContent?: boolean;
    includeSnippets?: boolean;
    includeSemantic?: boolean;
    maxDocuments?: number;
    maxCharsPerDocument?: number;
    accessPolicy?: Partial<AgentAccessPolicy>;
  };

  const { action, workspaceId = '' } = body;
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId requerido' }, { status: 400 });

  const auth = await verifyAccess(request, workspaceId);
  if (!auth) return NextResponse.json({ error: 'Sin acceso al workspace' }, { status: 403 });

  try {
    const normalizedAction = normalizeAction(action ?? '');
    const args: Record<string, unknown> = {
      ...body,
      documentId: body.documentId ?? body.id,
      title: body.title ?? body.name,
      newTitle: body.newTitle ?? body.title,
      targetFolder: body.targetFolder ?? body.folder
    };

    const result = await executeAgentTool(buildCall(normalizedAction, args), {
      workspaceId,
      uid: auth.uid,
      email: auth.email,
      origin: request.nextUrl.origin,
      llmEndpoint: typeof body.llmEndpoint === 'string' ? body.llmEndpoint : undefined,
      llmModel: typeof body.llmModel === 'string' ? body.llmModel : undefined,
      authToken: getTokenFromRequest(request) ?? undefined,
      accessPolicy: body.accessPolicy
    });

    const status = result.ok ? 200 : 500;
    return NextResponse.json(result, { status });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 });
  }
}
