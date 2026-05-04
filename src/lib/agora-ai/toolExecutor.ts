import type { AgentToolCall, AgentExecutionContext, AgentToolExecutionResult } from '@/lib/agora-ai/types';
import { getAgentAccessDenial } from '@/lib/agora-ai/accessPolicy';
import { writeAuditLog, fail } from '@/lib/agora-ai/toolExecutors/shared';
import { DOCUMENT_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/documents';
import { SNIPPET_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/snippets';
import { ST_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/st';
import { BOARD_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/board';
import { SEMANTIC_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/semantic';
import { WORKER_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/worker';
import { INTELLIGENCE_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/intelligence';
import { ADMIN_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/admin';
import { UI_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/ui';
import { OBSERVABILITY_TOOL_HANDLERS } from '@/lib/agora-ai/toolExecutors/observability';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  ...DOCUMENT_TOOL_HANDLERS,
  ...SNIPPET_TOOL_HANDLERS,
  ...ST_TOOL_HANDLERS,
  ...BOARD_TOOL_HANDLERS,
  ...SEMANTIC_TOOL_HANDLERS,
  ...WORKER_TOOL_HANDLERS,
  ...INTELLIGENCE_TOOL_HANDLERS,
  ...ADMIN_TOOL_HANDLERS,
  ...UI_TOOL_HANDLERS,
  ...OBSERVABILITY_TOOL_HANDLERS
};

export async function executeAgentTool(call: AgentToolCall, ctx: AgentExecutionContext): Promise<AgentToolExecutionResult> {
  try {
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
      await writeAuditLog(ctx, call, result);
      return result;
    }

    const handler = TOOL_HANDLERS[call.name];
    if (!handler) throw new Error(`Tool desconocida: ${call.name}`);
    const result = await handler(call, ctx);

    await writeAuditLog(ctx, call, result);
    return result;
  } catch (error) {
    const result = fail(call, error);
    await writeAuditLog(ctx, call, result);
    return result;
  }
}
