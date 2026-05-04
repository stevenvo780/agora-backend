/**
 * Logger JSON estructurado para el agente. Cloud Run (y stackdriver) ingiere
 * stdout JSON nativamente — cada línea queda como una entrada estructurada
 * filtrable por `jsonPayload.kind`, `jsonPayload.tool`, etc.
 *
 * Reemplaza los `console.log('[scope] msg')` sueltos del agente.
 */

export type AgentLogEvent = {
  kind: string;
  ts?: string;
  uid?: string | null;
  workspaceId?: string | null;
  requestId?: string | null;
  tool?: string;
  callId?: string;
  durationMs?: number;
  ok?: boolean;
  error?: string;
} & Record<string, unknown>;

export function logAgentEvent(event: AgentLogEvent) {
  const payload = {
    ts: new Date().toISOString(),
    severity: event.error ? 'ERROR' : 'INFO',
    component: 'agora-agent',
    ...event
  };
  // stdout JSON line — Cloud Run/Stackdriver lo parsea como structured log.
  // En desarrollo (NODE_ENV !== 'production') hacemos pretty para legibilidad.
  if (process.env.NODE_ENV === 'production') {
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    process.stdout.write(`[agent ${payload.kind}] ${JSON.stringify(payload)}\n`);
  }
}
