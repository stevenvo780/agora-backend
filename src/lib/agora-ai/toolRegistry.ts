import { AGORA_AGENT_TOOLS } from '@/lib/agora-ai/toolDefinitions';
import { getRequiredAgentCapability } from '@/lib/agora-ai/accessPolicy';
import type { AgentAccessCapability, AgentToolDefinition } from '@/lib/agora-ai/types';

const CACHEABLE_TOOL_NAMES = new Set([
  'list_documents', 'list_folders', 'read_document', 'search_documents',
  'inspect_workspace', 'list_snippets', 'get_semantic_state',
  'list_kanban_cards', 'list_st_definitions', 'workspace_status',
  'get_document_metadata', 'fetch_url', 'read_agora_doc'
]);

const DESTRUCTIVE_TOOL_NAMES = new Set([
  'delete_document', 'delete_file', 'delete_folder',
  'overwrite_document', 'rollback_action', 'rollback_last',
  'run_worker_command'
]);

export interface AgentToolRegistryEntry {
  name: string;
  definition: AgentToolDefinition;
  capability: AgentAccessCapability | null;
  destructive: boolean;
  cacheable: boolean;
  examples: string[];
}

export const AGORA_AGENT_TOOL_REGISTRY: AgentToolRegistryEntry[] = AGORA_AGENT_TOOLS.map((definition) => ({
  name: definition.name,
  definition,
  capability: getRequiredAgentCapability({ id: 'registry', name: definition.name, args: {} }),
  destructive: DESTRUCTIVE_TOOL_NAMES.has(definition.name),
  cacheable: CACHEABLE_TOOL_NAMES.has(definition.name),
  examples: []
}));

export const AGORA_AGENT_TOOL_REGISTRY_BY_NAME = new Map(
  AGORA_AGENT_TOOL_REGISTRY.map((entry) => [entry.name, entry])
);

export const isCacheableAgentTool = (name: string): boolean => (
  AGORA_AGENT_TOOL_REGISTRY_BY_NAME.get(name)?.cacheable === true
);

export const isDestructiveAgentTool = (name: string): boolean => (
  AGORA_AGENT_TOOL_REGISTRY_BY_NAME.get(name)?.destructive === true
);
