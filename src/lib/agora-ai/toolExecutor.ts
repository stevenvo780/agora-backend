import type { AgentToolCall, AgentExecutionContext, AgentToolExecutionResult } from '@/lib/agora-ai/types';
import { getAgentAccessDenial } from '@/lib/agora-ai/accessPolicy';
import { writeAuditLog, fail } from '@/lib/agora-ai/toolExecutors/shared';
import { DOCUMENT_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/documents';
import { SNIPPET_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/snippets';
import { ST_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/st';
import { ST_TYPED_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/st-typed';
import { BOARD_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/board';
import { SEMANTIC_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/semantic';
import { WORKER_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/worker';
import { INTELLIGENCE_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/intelligence';
import { ADMIN_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/admin';
import { UI_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/ui';
import { OBSERVABILITY_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/observability';
import { FORGEJO_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/git';
import { SUBSCRIPTION_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/subscription';
import { AGENT_CONTROL_TOOL_HANDLERS, getCachedToolResult, setCachedToolResult } from '@/lib/agora-ai/toolExecutors/agentControl';
import { logAgentEvent } from '@/lib/agora-ai/logger';
import { isDestructiveAgentTool } from '@/lib/agora-ai/toolRegistry';

const isDestructiveToolName = (name: string) => isDestructiveAgentTool(name) || name.startsWith('delete_') || name === 'update_document' || name === 'write_worker_file' || name === 'overwrite_document';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  ...DOCUMENT_TOOL_HANDLERS,
  ...SNIPPET_TOOL_HANDLERS,
  ...ST_TOOL_HANDLERS,
  ...ST_TYPED_TOOL_HANDLERS,
  ...BOARD_TOOL_HANDLERS,
  ...SEMANTIC_TOOL_HANDLERS,
  ...WORKER_TOOL_HANDLERS,
  ...INTELLIGENCE_TOOL_HANDLERS,
  ...ADMIN_TOOL_HANDLERS,
  ...UI_TOOL_HANDLERS,
  ...OBSERVABILITY_TOOL_HANDLERS,
  ...FORGEJO_TOOL_HANDLERS,
  ...SUBSCRIPTION_TOOL_HANDLERS,
  ...AGENT_CONTROL_TOOL_HANDLERS
};

export async function executeAgentTool(call: AgentToolCall, ctx: AgentExecutionContext): Promise<AgentToolExecutionResult> {
  const startedAt = Date.now();
  try {
    // Idempotency: si la misma callId ya se ejecutó en este turno, devolver cached.
    const cached = getCachedToolResult(call, ctx);
    if (cached) {
      logAgentEvent({
        kind: 'tool.idempotent_hit', tool: call.name, callId: call.id,
        uid: ctx.uid, workspaceId: ctx.workspaceId
      });
      return cached;
    }

    const denial = getAgentAccessDenial(call, ctx.accessPolicy);
    if (denial) {
      const result: AgentToolExecutionResult = {
        ok: false,
        name: call.name,
        callId: call.id,
        summary: denial.message,
        error: denial.message,
        data: {
          accessDenied: true,
          requiredCapability: denial.capability,
          profile: denial.profile,
          diagnostic: {
            severity: 'warning',
            message: `Tool bloqueada: ${call.name}`,
            detail: denial.message,
            code: 'agent-access-policy'
          }
        }
      };
      logAgentEvent({
        kind: 'tool.denied', tool: call.name, callId: call.id,
        uid: ctx.uid, workspaceId: ctx.workspaceId,
        capability: denial.capability, profile: denial.profile
      });
      setCachedToolResult(call, ctx, result);
      await writeAuditLog(ctx, call, result);
      return result;
    }

    const handler = TOOL_HANDLERS[call.name];
    if (!handler) throw new Error(`Tool desconocida: ${call.name}`);

    // DRY-RUN: tools destructivas devuelven simulación sin aplicar.
    if (ctx.dryRun && isDestructiveToolName(call.name)) {
      const result: AgentToolExecutionResult = {
        ok: true,
        name: call.name,
        callId: call.id,
        summary: `[DRY-RUN] ${call.name} no se ejecutó. Args: ${JSON.stringify(call.args).slice(0, 200)}`,
        data: { dryRun: true, wouldHaveCalled: call.name, wouldHaveArgs: call.args }
      };
      logAgentEvent({ kind: 'tool.dry_run', tool: call.name, callId: call.id, uid: ctx.uid, workspaceId: ctx.workspaceId });
      setCachedToolResult(call, ctx, result);
      await writeAuditLog(ctx, call, result);
      return result;
    }

    const result = await handler(call, ctx);
    const durationMs = Date.now() - startedAt;

    logAgentEvent({
      kind: 'tool.ok', tool: call.name, callId: call.id,
      uid: ctx.uid, workspaceId: ctx.workspaceId,
      durationMs, ok: result.ok !== false
    });

    setCachedToolResult(call, ctx, result);
    await writeAuditLog(ctx, call, result);
    return result;
  } catch (error) {
    const result = fail(call, error);
    const durationMs = Date.now() - startedAt;
    logAgentEvent({
      kind: 'tool.error', tool: call.name, callId: call.id,
      uid: ctx.uid, workspaceId: ctx.workspaceId,
      durationMs,
      error: error instanceof Error ? error.message : String(error)
    });
    await writeAuditLog(ctx, call, result);
    return result;
  }
}
