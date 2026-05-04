import { normalizeFolderPath } from '@/lib/folder-utils';
import type { AgentToolCall, AgentToolExecutionResult, AgentExecutionContext } from '@/lib/agora-ai/types';
import { commandTypeForPanel, isAgentUiPanel } from '@/lib/agora-ai/uiPanels';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

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

export async function focusDocumentSection(call: AgentToolCall): Promise<AgentToolExecutionResult> {
  const documentId = String(call.args.documentId || '').trim();
  const headingTitle = typeof call.args.headingTitle === 'string' ? call.args.headingTitle.trim() : '';
  const line = typeof call.args.line === 'number' ? call.args.line : null;
  if (!documentId) throw new Error('documentId es requerido');
  return {
    ok: true,
    name: call.name,
    callId: call.id,
    summary: `Enfocando sección${headingTitle ? ` "${headingTitle}"` : line ? ` (línea ${line})` : ''} de "${documentId}".`,
    data: {
      uiCommand: {
        type: 'focus-document-section',
        documentId,
        headingTitle: headingTitle || null,
        line
      }
    },
    rollback: []
  };
}

export async function promptUserChoice(call: AgentToolCall): Promise<AgentToolExecutionResult> {
  const question = String(call.args.question || '').trim();
  const choicesRaw = Array.isArray(call.args.choices) ? call.args.choices.map(String) : [];
  if (!question) throw new Error('question es requerida');
  if (choicesRaw.length < 2 || choicesRaw.length > 8) throw new Error('Debe haber entre 2 y 8 choices');
  return {
    ok: true,
    name: call.name,
    callId: call.id,
    summary: `Esperando elección del usuario: "${question}" (${choicesRaw.length} opciones).`,
    data: {
      uiCommand: {
        type: 'prompt-user-choice',
        question,
        choices: choicesRaw
      }
    },
    rollback: []
  };
}

export async function showDiffToUser(call: AgentToolCall): Promise<AgentToolExecutionResult> {
  const before = String(call.args.before || '');
  const after = String(call.args.after || '');
  const title = typeof call.args.title === 'string' ? call.args.title : 'Diff propuesto';
  if (!before && !after) throw new Error('before o after son requeridos');
  return {
    ok: true,
    name: call.name,
    callId: call.id,
    summary: `Mostrando diff "${title}" al usuario (${before.length} → ${after.length} bytes).`,
    data: {
      uiCommand: {
        type: 'show-diff',
        title,
        before,
        after
      }
    },
    rollback: []
  };
}

export async function reportStatusToUser(call: AgentToolCall): Promise<AgentToolExecutionResult> {
  const status = String(call.args.status || '').trim();
  const detail = typeof call.args.detail === 'string' ? call.args.detail : '';
  if (!status) throw new Error('status es requerido');
  return {
    ok: true,
    name: call.name,
    callId: call.id,
    summary: status,
    data: {
      uiCommand: {
        type: 'agent-status',
        status,
        detail
      }
    },
    rollback: []
  };
}

export const UI_TOOL_HANDLERS: Record<string, ToolHandler> = {
  open_app_panel: openAppPanel,
  focus_document_section: focusDocumentSection,
  prompt_user_choice: promptUserChoice,
  show_diff_to_user: showDiffToUser,
  report_status_to_user: reportStatusToUser
};