import { normalizeFolderPath } from '@/lib/folder-utils';
import type { AgentToolCall, AgentToolExecutionResult } from '@/lib/agora-ai/types';
import { commandTypeForPanel, isAgentUiPanel } from '@/lib/agora-ai/uiPanels';

export async function openAppPanel(call: AgentToolCall): Promise<AgentToolExecutionResult> {
  const panel = String(call.args.panel || '').trim();
  if (!isAgentUiPanel(panel)) throw new Error(`Panel no soportado: ${panel}`);
  const folder = typeof call.args.folder === 'string' && call.args.folder.trim()
    ? normalizeFolderPath(call.args.folder)
    : undefined;
  const type = commandTypeForPanel(panel);

  return {
    ok: true,
    name: call.name,
    callId: call.id,
    summary: `Abrí/enfoqué el panel ${panel}.`,
    data: {
      uiCommand: {
        type,
        panel,
        folder
      }
    },
    rollback: []
  };
}