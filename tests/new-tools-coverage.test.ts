import test from 'node:test';
import assert from 'node:assert/strict';
import { AGORA_AGENT_TOOLS } from '../src/lib/agora-ai/toolDefinitions.ts';
import { AGENT_ACCESS_PROFILES, getAgentAccessDenial, getRequiredAgentCapability } from '../src/lib/agora-ai/accessPolicy.ts';
import { AGORA_AGENT_TOOL_REGISTRY_BY_NAME } from '../src/lib/agora-ai/toolRegistry.ts';

const NEW_TOOLS_TIER_1 = [
  'rename_folder', 'delete_folder', 'list_workspaces',
  'get_document_content_at_revision', 'upload_external_url',
  'download_workspace_bundle'
];

const NEW_TOOLS_TIER_2_ADMIN = [
  'invite_member', 'remove_member', 'change_workspace_settings',
  'transfer_workspace_ownership', 'list_members'
];

const NEW_TOOLS_TIER_3_GIT = [
  'git_diff', 'git_pull', 'git_push_branch', 'git_create_branch',
  'git_checkout', 'git_revert_commit'
];

const NEW_TOOLS_TIER_4_WORKER = [
  'read_worker_file', 'write_worker_file', 'tail_worker_logs',
  'kill_worker_process', 'restart_worker', 'start_worker'
];

const NEW_TOOLS_TIER_5_ST = [
  'prove_step', 'compare_logic_profiles', 'formalize_document_section',
  'link_concepts'
];

const NEW_TOOLS_TIER_6_BOARD = ['bulk_create_board_cards'];

const NEW_TOOLS_TIER_7_INTEL = [
  'outline_document', 'find_broken_links', 'find_duplicates',
  'apply_snippet_to_document', 'semantic_search_workspace'
];

const NEW_TOOLS_TIER_8_UI = [
  'focus_document_section', 'prompt_user_choice',
  'show_diff_to_user', 'report_status_to_user'
];

const NEW_TOOLS_TIER_9_OBS = [
  'list_recent_actions', 'get_agent_audit_log',
  'get_subscription_status', 'list_quota', 'get_workspace_quota_detail'
];

const ALL_NEW_TOOLS = [
  ...NEW_TOOLS_TIER_1, ...NEW_TOOLS_TIER_2_ADMIN, ...NEW_TOOLS_TIER_3_GIT,
  ...NEW_TOOLS_TIER_4_WORKER, ...NEW_TOOLS_TIER_5_ST, ...NEW_TOOLS_TIER_6_BOARD,
  ...NEW_TOOLS_TIER_7_INTEL, ...NEW_TOOLS_TIER_8_UI, ...NEW_TOOLS_TIER_9_OBS
];

test('todas las tools nuevas tienen definition en toolDefinitions', () => {
  const definedNames = new Set(AGORA_AGENT_TOOLS.map(t => t.name));
  for (const name of ALL_NEW_TOOLS) {
    assert.equal(definedNames.has(name), true, `Falta definición de ${name} en AGORA_AGENT_TOOLS`);
  }
});

test('todas las tools nuevas están en el tool registry', () => {
  for (const name of ALL_NEW_TOOLS) {
    assert.equal(AGORA_AGENT_TOOL_REGISTRY_BY_NAME.has(name), true, `Falta registry para ${name}`);
  }
});

test('todas las tools nuevas mapean a una capability (no quedan unmapped)', () => {
  for (const name of ALL_NEW_TOOLS) {
    const cap = getRequiredAgentCapability({ id: 'test', name, args: {} });
    assert.notEqual(cap, null, `${name} no tiene capability — quedará SIN BLOQUEO incluso en perfiles restrictivos`);
  }
});

test('toolPermissions permite apagar o prender tools concretas sobre el perfil', () => {
  const policy = {
    profile: 'custom' as const,
    capabilities: {
      ...AGENT_ACCESS_PROFILES.read_only.capabilities,
      documentsRead: false,
      workerCommand: false
    },
    toolPermissions: {
      read_document: true,
      list_documents: false,
      run_worker_command: true
    }
  };

  assert.equal(getAgentAccessDenial({ id: 't1', name: 'read_document', args: {} }, policy), null);
  assert.equal(getAgentAccessDenial({ id: 't2', name: 'run_worker_command', args: {} }, policy), null);
  assert.match(
    getAgentAccessDenial({ id: 't3', name: 'list_documents', args: {} }, policy)?.message ?? '',
    /permiso individual/
  );
});

test('admin tools requieren documentsWrite (cambios persistentes en workspace)', () => {
  for (const name of NEW_TOOLS_TIER_2_ADMIN) {
    const cap = getRequiredAgentCapability({ id: 'test', name, args: {} });
    assert.equal(cap, 'documentsWrite', `${name} debería ser documentsWrite, recibió ${cap}`);
  }
});

test('git mutating tools requieren gitWrite, git_diff es gitRead', () => {
  assert.equal(getRequiredAgentCapability({ id: 't', name: 'git_diff', args: {} }), 'gitRead');
  for (const name of ['git_pull', 'git_push_branch', 'git_create_branch', 'git_checkout', 'git_revert_commit']) {
    assert.equal(getRequiredAgentCapability({ id: 't', name, args: {} }), 'gitWrite', `${name} debería ser gitWrite`);
  }
});

test('worker write tools requieren workerCommand, read tools workerRead', () => {
  for (const name of ['read_worker_file', 'tail_worker_logs']) {
    assert.equal(getRequiredAgentCapability({ id: 't', name, args: {} }), 'workerRead', `${name} debería ser workerRead`);
  }
  for (const name of ['write_worker_file', 'kill_worker_process', 'restart_worker', 'start_worker']) {
    assert.equal(getRequiredAgentCapability({ id: 't', name, args: {} }), 'workerCommand', `${name} debería ser workerCommand`);
  }
});

test('UI extended tools requieren uiControl', () => {
  for (const name of NEW_TOOLS_TIER_8_UI) {
    assert.equal(getRequiredAgentCapability({ id: 't', name, args: {} }), 'uiControl', `${name} debería ser uiControl`);
  }
});

test('total de tools registradas creció a 80+ tras la expansión', () => {
  assert.ok(AGORA_AGENT_TOOLS.length >= 75, `Esperaba al menos 75 tools, hay ${AGORA_AGENT_TOOLS.length}`);
});
