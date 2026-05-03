import type {
  AgentAccessCapabilities,
  AgentAccessCapability,
  AgentAccessPolicy,
  AgentAccessProfileId,
  AgentToolCall
} from '@/lib/agora-ai/types';

export const AGENT_ACCESS_CAPABILITIES: AgentAccessCapability[] = [
  'workspaceContext',
  'documentsRead',
  'documentsWrite',
  'documentsDelete',
  'snippets',
  'board',
  'semantic',
  'logic',
  'gitRead',
  'gitWrite',
  'workerRead',
  'workerCommand',
  'uiControl',
  'debug'
];

const allCapabilities = (enabled: boolean): AgentAccessCapabilities => Object.fromEntries(
  AGENT_ACCESS_CAPABILITIES.map((capability) => [capability, enabled])
) as AgentAccessCapabilities;

const withCapabilities = (enabled: AgentAccessCapability[]): AgentAccessCapabilities => ({
  ...allCapabilities(false),
  ...Object.fromEntries(enabled.map((capability) => [capability, true]))
}) as AgentAccessCapabilities;

export const AGENT_ACCESS_PROFILE_ORDER: Array<Exclude<AgentAccessProfileId, 'custom'>> = [
  'read_only',
  'editor',
  'workspace',
  'developer'
];

export const AGENT_ACCESS_PROFILES: Record<Exclude<AgentAccessProfileId, 'custom'>, {
  id: Exclude<AgentAccessProfileId, 'custom'>;
  label: string;
  shortLabel: string;
  description: string;
  capabilities: AgentAccessCapabilities;
}> = {
  read_only: {
    id: 'read_only',
    label: 'Solo lectura',
    shortLabel: 'Lectura',
    description: 'Puede leer contexto, buscar, razonar y abrir paneles, sin escribir ni ejecutar comandos.',
    capabilities: withCapabilities([
      'workspaceContext',
      'documentsRead',
      'semantic',
      'logic',
      'uiControl',
      'debug'
    ])
  },
  editor: {
    id: 'editor',
    label: 'Editor seguro',
    shortLabel: 'Editor',
    description: 'Puede crear y editar documentos, snippets, tablero y glosario. No borra, no commitea ni ejecuta terminal.',
    capabilities: withCapabilities([
      'workspaceContext',
      'documentsRead',
      'documentsWrite',
      'snippets',
      'board',
      'semantic',
      'logic',
      'uiControl',
      'debug'
    ])
  },
  workspace: {
    id: 'workspace',
    label: 'Workspace',
    shortLabel: 'Workspace',
    description: 'Perfil de trabajo diario: edición, estado Git y lectura del worker. Las acciones peligrosas siguen bloqueadas.',
    capabilities: withCapabilities([
      'workspaceContext',
      'documentsRead',
      'documentsWrite',
      'snippets',
      'board',
      'semantic',
      'logic',
      'gitRead',
      'workerRead',
      'uiControl',
      'debug'
    ])
  },
  developer: {
    id: 'developer',
    label: 'Desarrollador',
    shortLabel: 'Dev',
    description: 'Acceso completo a tools, Git y worker. Las tools destructivas todavía piden confirmación explícita.',
    capabilities: allCapabilities(true)
  }
};

export const DEFAULT_AGENT_ACCESS_POLICY: AgentAccessPolicy = {
  profile: 'developer',
  capabilities: AGENT_ACCESS_PROFILES.developer.capabilities
};

export const DEFAULT_CLIENT_AGENT_ACCESS_POLICY: AgentAccessPolicy = {
  profile: 'workspace',
  capabilities: AGENT_ACCESS_PROFILES.workspace.capabilities
};

export function normalizeAgentAccessPolicy(
  policy?: Partial<AgentAccessPolicy>,
  fallback: AgentAccessPolicy = DEFAULT_AGENT_ACCESS_POLICY
): AgentAccessPolicy {
  const requestedProfile = policy?.profile;
  const profile: AgentAccessProfileId =
    requestedProfile === 'read_only'
    || requestedProfile === 'editor'
    || requestedProfile === 'workspace'
    || requestedProfile === 'developer'
    || requestedProfile === 'custom'
      ? requestedProfile
      : fallback.profile;

  const profileDefaults = profile === 'custom'
    ? fallback.capabilities
    : AGENT_ACCESS_PROFILES[profile].capabilities;

  return {
    profile,
    capabilities: {
      ...profileDefaults,
      ...(policy?.capabilities || {})
    }
  };
}

export function createAgentAccessPolicyFromProfile(
  profile: Exclude<AgentAccessProfileId, 'custom'>
): AgentAccessPolicy {
  return {
    profile,
    capabilities: { ...AGENT_ACCESS_PROFILES[profile].capabilities }
  };
}

const DOCUMENT_READ_TOOLS = new Set([
  'list_documents',
  'list_files',
  'read_document',
  'read_file',
  'search_documents',
  'list_folders',
  'get_workspace_info',
  'inspect_workspace',
  'search_workspace',
  'read_workspace_bundle',
  'summarize_document',
  'compare_documents',
  'analyze_document'
]);

const DOCUMENT_WRITE_TOOLS = new Set([
  'create_document',
  'create_file',
  'update_document',
  'rename_document',
  'rename_file',
  'move_document',
  'create_folder',
  'restore_document'
]);

const DOCUMENT_DELETE_TOOLS = new Set([
  'delete_document',
  'delete_file'
]);

const SNIPPET_TOOLS = new Set([
  'list_snippets',
  'create_snippet',
  'read_snippet',
  'search_snippets',
  'update_snippet',
  'delete_snippet'
]);

const BOARD_TOOLS = new Set([
  'get_board',
  'create_board_column',
  'rename_board_column',
  'delete_board_column',
  'create_board_card',
  'update_board_card',
  'move_board_card',
  'delete_board_card',
  'restore_board_card',
  'restore_board_column',
  'extract_pending_tasks'
]);

const SEMANTIC_TOOLS = new Set([
  'get_semantic_state',
  'list_concepts',
  'define_concept',
  'create_relation',
  'list_glossary_entries',
  'search_glossary_entries'
]);

const LOGIC_TOOLS = new Set([
  'check_logic',
  'formalize_text',
  'list_st_profiles',
  'validate_st_syntax',
  'run_st_program',
  'render_st_glossary',
  'explain_formalization'
]);

export function getRequiredAgentCapability(call: AgentToolCall): AgentAccessCapability | null {
  if (DOCUMENT_READ_TOOLS.has(call.name)) return 'documentsRead';
  if (DOCUMENT_WRITE_TOOLS.has(call.name)) return 'documentsWrite';
  if (DOCUMENT_DELETE_TOOLS.has(call.name)) return 'documentsDelete';
  if (SNIPPET_TOOLS.has(call.name)) return 'snippets';
  if (BOARD_TOOLS.has(call.name)) return 'board';
  if (SEMANTIC_TOOLS.has(call.name)) return 'semantic';
  if (LOGIC_TOOLS.has(call.name)) return 'logic';
  if (call.name === 'git_status' || call.name === 'git_log') return 'gitRead';
  if (call.name === 'git_commit_workspace') return 'gitWrite';
  if (call.name === 'get_worker_status' || call.name === 'list_worker_files' || call.name === 'sync_status') return 'workerRead';
  if (call.name === 'run_worker_command') return 'workerCommand';
  if (call.name === 'open_app_panel') return 'uiControl';
  if (call.name === 'report_debug') return 'debug';
  return null;
}

export function getAgentAccessDenial(
  call: AgentToolCall,
  policy?: Partial<AgentAccessPolicy>
) {
  const capability = getRequiredAgentCapability(call);
  if (!capability) return null;
  const normalized = normalizeAgentAccessPolicy(policy);
  if (normalized.capabilities[capability]) return null;
  return {
    capability,
    profile: normalized.profile,
    message: `Tool bloqueada por el perfil de acceso "${normalized.profile}": ${call.name} requiere ${capability}.`
  };
}
