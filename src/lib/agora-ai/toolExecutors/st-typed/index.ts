import type { AgentToolCall, AgentExecutionContext, AgentToolExecutionResult } from '@/lib/agora-ai/types';
import { stCheck } from './check';
import { stDerive } from './derive';
import { stCountermodel } from './countermodel';
import { stFormalize } from './formalize';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

export const ST_TYPED_TOOL_HANDLERS: Record<string, ToolHandler> = {
  st_check: stCheck,
  st_derive: stDerive,
  st_countermodel: stCountermodel,
  st_formalize: stFormalize
};

export { stCheck, stDerive, stCountermodel, stFormalize };
