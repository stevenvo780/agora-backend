export type AIProvider = 'openai' | 'anthropic' | 'ollama' | 'gemini' | 'deepseek';
export type AgentMode = 'chat' | 'agent';

export type AgentAccessProfileId = 'read_only' | 'editor' | 'workspace' | 'developer' | 'custom';

export type AgentAccessCapability =
  | 'workspaceContext'
  | 'documentsRead'
  | 'documentsWrite'
  | 'documentsDelete'
  | 'snippets'
  | 'board'
  | 'semantic'
  | 'logic'
  | 'gitRead'
  | 'gitWrite'
  | 'workerRead'
  | 'workerCommand'
  | 'uiControl'
  | 'debug';

export type AgentAccessCapabilities = Record<AgentAccessCapability, boolean>;

export interface AgentAccessPolicy {
  profile: AgentAccessProfileId;
  capabilities: AgentAccessCapabilities;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentPendingConfirmation {
  toolCallId: string;
  toolName: string;
  prompt: string;
  args: Record<string, unknown>;
}

export interface AgentRollbackAction {
  action: string;
  args: Record<string, unknown>;
}

export interface AgentToolExecutionResult {
  ok: boolean;
  name: string;
  callId: string;
  summary: string;
  data?: Record<string, unknown>;
  error?: string;
  requiresConfirmation?: boolean;
  pendingConfirmation?: AgentPendingConfirmation;
  rollback?: AgentRollbackAction[];
  /** True cuando se sirvió desde el cache de tools del turno (no se ejecutó). */
  cached?: boolean;
}

export interface AgentTraceStep {
  id: string;
  type: 'thinking' | 'plan' | 'tool_call' | 'tool_result' | 'final' | 'confirmation' | 'error';
  title: string;
  content?: string;
  call?: AgentToolCall;
  result?: AgentToolExecutionResult;
  startedAt: number;
  finishedAt?: number;
}

export interface AgentUsageStats {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Costo estimado en USD (calculado del lado server). */
  estimatedCostUsd?: number;
}

export interface AgentRun {
  mode: AgentMode;
  provider: AIProvider;
  iterations: number;
  steps: AgentTraceStep[];
  finalReply: string;
  pendingConfirmation?: AgentPendingConfirmation;
  rollback?: AgentRollbackAction[];
  /** True cuando se cortó por timeout/budget antes de la respuesta natural. */
  truncated?: boolean;
  /** Tokens y costo agregados de todas las llamadas al provider. */
  usage?: AgentUsageStats;
}

export interface AgentStoredChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
  agentRun?: AgentRun;
  pendingConfirmation?: AgentPendingConfirmation;
}

export interface AgentChatSession {
  id: string;
  title: string;
  workspaceId: string;
  provider: AIProvider;
  mode: AgentMode;
  messages: AgentStoredChatMessage[];
  rollbackQueue: AgentRollbackAction[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentDocumentTarget {
  id: string;
  name: string;
  type?: string;
  folder?: string;
  content?: string;
  mimeType?: string | null;
  workspaceId?: string;
  ownerId?: string;
}

export interface AgentOpenDocumentsEventDetail {
  workspaceId: string;
  documents: AgentDocumentTarget[];
  focusFolder?: string;
  source: 'agora-ai';
}

export interface AgentDocumentsMutatedEventDetail {
  workspaceId: string;
  mutations: Array<{
    action: string;
    result: AgentToolExecutionResult;
  }>;
  source: 'agora-ai';
}

export interface AgentToolResultEventDetail {
  workspaceId: string;
  result: AgentToolExecutionResult;
  source: 'agora-ai';
}

export interface AgentWorkerCommandEventDetail {
  workspaceId: string;
  command: string;
  cwd?: string;
  ok: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  source: 'agora-ai';
}

export type AgentUiPanel =
  | 'files'
  | 'search'
  | 'git'
  | 'snippets'
  | 'board'
  | 'semantic'
  | 'st'
  | 'formalizer'
  | 'ai'
  | 'ai-config'
  | 'linter-config'
  | 'terminal'
  | 'problems'
  | 'settings';

export interface AgentUiCommand {
  type: 'open_panel' | 'focus_folder' | 'open_terminal' | 'open_problems' | 'open_ai_config' | 'open_linter_config';
  panel?: AgentUiPanel;
  folder?: string;
}

export interface AgentUiCommandEventDetail {
  workspaceId: string;
  command: AgentUiCommand;
  source: 'agora-ai';
}

export interface AgentDiagnosticEventDetail {
  workspaceId: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  detail?: string;
  code?: string;
  source: 'agora-ai';
}

export type AgentStreamEvent =
  | { type: 'connected' }
  | { type: 'status'; status: string }
  | { type: 'step'; step: AgentTraceStep }
  | { type: 'complete'; reply: string; agentRun: AgentRun }
  | { type: 'error'; error: string };

export interface ToolJsonSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: ToolJsonSchema;
}

export interface AgentRequestBody {
  messages: ChatMessage[];
  workspaceId?: string;
  provider: AIProvider;
  apiKey?: string;
  model?: string;
  mode?: AgentMode;
  accessPolicy?: Partial<AgentAccessPolicy>;
}

export interface AgentResponseBody {
  reply: string;
  agentRun?: AgentRun;
  error?: string;
}

export interface AgentExecutionContext {
  workspaceId: string;
  uid: string;
  email?: string | null;
  origin?: string;
  llmEndpoint?: string;
  llmModel?: string;
  authToken?: string;
  accessPolicy?: Partial<AgentAccessPolicy>;
  /** Función que devuelve los ms transcurridos en la solicitud. */
  elapsedBudgetMs?: () => number;
  /** Presupuesto máximo en ms — el agente debe terminar antes para poder
   *  emitir un `complete` con `truncated: true`. */
  maxBudgetMs?: number;
  /**
   * Ejecutor de tools inyectado. En el hub Next.js usa `executeAgentTool`
   * directo; en AgoraBackend (Cloud Run) llama al hub por HTTP.
   * Si está ausente, los tool calls fallan con `tool_executor_not_wired`.
   */
  executeAgentTool?: (
    call: AgentToolCall,
    ctx: AgentExecutionContext
  ) => Promise<AgentToolExecutionResult>;
}
