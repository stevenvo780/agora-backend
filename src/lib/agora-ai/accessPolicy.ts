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
    description: 'Acceso completo a tools, Git y worker. Omite confirmaciones destructivas: úsalo solo cuando quieras control total.',
    capabilities: allCapabilities(true)
  }
};

/** Perfiles que omiten el modal de confirmación de acciones destructivas.
 *  Debe estar sincronizado con el front (AgoraFront/src/lib/agora-ai/accessPolicy.ts). */
export const AGENT_AUTO_CONFIRM_PROFILES: ReadonlySet<AgentAccessProfileId> = new Set(['developer']);

export function profileAutoConfirms(profile: AgentAccessProfileId): boolean {
  return AGENT_AUTO_CONFIRM_PROFILES.has(profile);
}

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
  const toolPermissions = policy?.toolPermissions && typeof policy.toolPermissions === 'object'
    ? Object.fromEntries(
        Object.entries(policy.toolPermissions).filter((entry): entry is [string, boolean] => (
          typeof entry[0] === 'string' && typeof entry[1] === 'boolean'
        ))
      )
    : undefined;

  return {
    profile,
    capabilities: {
      ...profileDefaults,
      ...(policy?.capabilities || {})
    },
    ...(toolPermissions && Object.keys(toolPermissions).length > 0 ? { toolPermissions } : {})
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
  'analyze_document',
  'list_workspaces',
  'get_document_content_at_revision',
  'download_workspace_bundle',
  'outline_document',
  'find_broken_links',
  'find_duplicates',
  'fetch_url',
  'read_agora_doc',
  'get_storage_usage',
  'find_large_documents',
  'list_recent_workspace_activity',
  'list_favorites',
  'lint_document',
  'lint_st_document',
  'extract_text_from_pdf',
  'list_dictionary_words',
  'find_unused_snippets',
  'query_citation_graph',
  'find_related_via_graph',
  'expand_context'
]);

const DOCUMENT_WRITE_TOOLS = new Set([
  'create_document',
  'create_file',
  'update_document',
  'rename_document',
  'rename_file',
  'move_document',
  'create_folder',
  'rename_folder',
  'restore_document',
  'upload_external_url',
  'apply_snippet_to_document',
  'duplicate_document',
  'add_favorite',
  'remove_favorite',
  'add_word_to_dictionary',
  'remove_word_from_dictionary'
]);

const DOCUMENT_DELETE_TOOLS = new Set([
  'delete_document',
  'delete_file',
  'delete_folder'
]);

const SNIPPET_TOOLS = new Set([
  'list_snippets',
  'create_snippet',
  'read_snippet',
  'search_snippets',
  'update_snippet',
  'delete_snippet',
  'import_snippets_from_url'
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
  'bulk_create_board_cards',
  'archive_board_card',
  'restore_board_card',
  'restore_board_column',
  'extract_pending_tasks'
]);

const SEMANTIC_TOOLS = new Set([
  'get_semantic_state',
  'list_concepts',
  'define_concept',
  'update_concept',
  'delete_concept',
  'create_relation',
  'update_relation',
  'delete_relation',
  'find_orphaned_concepts',
  'merge_concepts',
  // Aliases legacy aún ejecutables vía handler shim:
  'link_concepts',
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
  'explain_formalization',
  'prove_step',
  'compare_logic_profiles',
  'formalize_document_section',
  'st_check',
  'st_derive',
  'st_countermodel',
  'st_formalize'
]);

const ADMIN_TOOLS = new Set([
  'invite_member',
  'remove_member',
  'change_workspace_settings',
  'transfer_workspace_ownership',
  'list_members',
  'accept_invite',
  'decline_invite',
  'provision_workspace_git',
  'start_subscription_checkout'
]);

const OBSERVABILITY_TOOLS = new Set([
  'list_recent_actions',
  'get_agent_audit_log',
  'get_subscription_status',
  'list_quota',
  'get_workspace_quota_detail',
  'inspect_sync_outbox',
  'force_emit_sync_ping',
  'get_document_sync_state',
  'list_active_terminal_sessions',
  'get_repo_info',
  'list_workspace_repos'
]);

const UI_EXTENDED_TOOLS = new Set([
  'open_app_panel',
  'focus_document_section',
  'prompt_user_choice',
  'show_diff_to_user',
  'report_status_to_user',
  'agent_plan_set',
  'agent_plan_update_step',
  'agent_plan_get',
  'agent_plan_clear',
  'agent_remember',
  'agent_recall_memory',
  'agent_list_memories',
  'agent_forget',
  'register_subtask',
  'spawn_subagent',
  'agent_set_hooks',
  'agent_list_hooks',
  'agent_save_turn_snapshot',
  'agent_list_turn_snapshots',
  'agent_clear_turn_snapshot',
  'agent_dry_run_info'
]);

export function getRequiredAgentCapability(call: AgentToolCall): AgentAccessCapability | null {
  if (DOCUMENT_READ_TOOLS.has(call.name)) return 'documentsRead';
  if (DOCUMENT_WRITE_TOOLS.has(call.name)) return 'documentsWrite';
  if (DOCUMENT_DELETE_TOOLS.has(call.name)) return 'documentsDelete';
  if (SNIPPET_TOOLS.has(call.name)) return 'snippets';
  if (BOARD_TOOLS.has(call.name)) return 'board';
  if (SEMANTIC_TOOLS.has(call.name)) return 'semantic';
  if (LOGIC_TOOLS.has(call.name)) return 'logic';
  if (ADMIN_TOOLS.has(call.name)) return 'documentsWrite';
  if (OBSERVABILITY_TOOLS.has(call.name)) return 'documentsRead';
  if (UI_EXTENDED_TOOLS.has(call.name)) return 'uiControl';
  if (call.name === 'git_status' || call.name === 'git_log' || call.name === 'git_diff') return 'gitRead';
  if (
    call.name === 'git_commit_workspace' ||
    call.name === 'git_pull' ||
    call.name === 'git_push_branch' ||
    call.name === 'git_create_branch' ||
    call.name === 'git_checkout' ||
    call.name === 'git_revert_commit'
  ) return 'gitWrite';
  if (
    call.name === 'get_worker_status' ||
    call.name === 'list_worker_files' ||
    call.name === 'sync_status' ||
    call.name === 'read_worker_file' ||
    call.name === 'tail_worker_logs'
  ) return 'workerRead';
  if (
    call.name === 'run_worker_command' ||
    call.name === 'write_worker_file' ||
    call.name === 'kill_worker_process' ||
    call.name === 'restart_worker' ||
    call.name === 'start_worker' ||
    call.name === 'kill_terminal_session'
  ) return 'workerCommand';
  if (call.name === 'report_debug') return 'debug';
  return null;
}

export function getAgentToolAccessState(
  toolName: string,
  policy?: Partial<AgentAccessPolicy>
): {
  enabled: boolean;
  capability: AgentAccessCapability | null;
  source: 'tool' | 'capability' | 'unrestricted';
} {
  const normalized = normalizeAgentAccessPolicy(policy);
  const capability = getRequiredAgentCapability({ id: 'policy-check', name: toolName, args: {} });
  const override = normalized.toolPermissions?.[toolName];
  if (typeof override === 'boolean') {
    return { enabled: override, capability, source: 'tool' };
  }
  if (!capability) {
    return { enabled: true, capability: null, source: 'unrestricted' };
  }
  return { enabled: normalized.capabilities[capability] === true, capability, source: 'capability' };
}

export function isAgentToolAllowedByPolicy(
  toolName: string,
  policy?: Partial<AgentAccessPolicy>
): boolean {
  return getAgentToolAccessState(toolName, policy).enabled;
}

export function getAgentAccessDenial(
  call: AgentToolCall,
  policy?: Partial<AgentAccessPolicy>
) {
  const normalized = normalizeAgentAccessPolicy(policy);
  const capability = getRequiredAgentCapability(call);
  const toolOverride = normalized.toolPermissions?.[call.name];
  if (toolOverride === false) {
    return {
      capability,
      profile: normalized.profile,
      toolName: call.name,
      message: `Tool bloqueada por permiso individual: ${call.name}.`
    };
  }
  if (toolOverride === true) return null;
  if (!capability) return null;
  if (normalized.capabilities[capability]) return null;
  return {
    capability,
    profile: normalized.profile,
    message: `Tool bloqueada por el perfil de acceso "${normalized.profile}": ${call.name} requiere ${capability}.`
  };
}
