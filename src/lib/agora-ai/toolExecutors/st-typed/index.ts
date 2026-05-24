import type { AgentToolCall, AgentExecutionContext, AgentToolExecutionResult } from '@/lib/agora-ai/types';
import { stCheck } from './check';
import { stDerive } from './derive';
import { stCountermodel } from './countermodel';
import { stFormalize } from './formalize';
import { stProofMine } from './proof-mine';
import { stTacticApply } from './tactic-apply';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

export const ST_TYPED_TOOL_HANDLERS: Record<string, ToolHandler> = {
  st_check: stCheck,
  st_derive: stDerive,
  st_countermodel: stCountermodel,
  st_formalize: stFormalize,
  st_proof_mine: stProofMine,
  st_tactic_apply: stTacticApply,
};

export { stCheck, stDerive, stCountermodel, stFormalize, stProofMine, stTacticApply };
