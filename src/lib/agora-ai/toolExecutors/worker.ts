import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, confirm, clamp, truncateText,
  fetchWorkerStatus, fetchNexusJson, fetchAppJson, fetchAppSseEvents,
  resolveWorkerWorkspaceId, loadWorkspaceDocuments,
  getErrorMessage, DocumentType, MAX_DOC_SCAN
} from './shared';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

const FORBIDDEN_COMMAND_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\bsudo\b|\bsu\s+-?|\bpasswd\b/, message: 'Comandos de privilegios o cambio de usuario no permitidos.' },
  { pattern: /\b(mkfs|fdisk|parted|mount|umount|shutdown|reboot|poweroff)\b/, message: 'Comandos de sistema no permitidos.' },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/, message: 'Patrones de fork bomb no permitidos.' },
  { pattern: /\brm\s+(-[^\n;|&]*[rR][^\n;|&]*[fF]|-[^\n;|&]*[fF][^\n;|&]*[rR])\s+(\/|\/\*|~|\$HOME)(\s|$)/, message: 'No se permite borrar rutas raíz, home o absolutas peligrosas.' }
];

function validateWorkerCommand(command: string) {
  if (!command.trim()) throw new Error('command es requerido');
  if (command.length > 4000) throw new Error('command excede 4000 caracteres');
  if (command.includes('\0')) throw new Error('command contiene caracteres nulos');
  const blocked = FORBIDDEN_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(command));
  if (blocked) throw new Error(blocked.message);
}

async function runWorkerCommand(call: AgentToolCall, ctx: AgentExecutionContext) {
  const command = String(call.args.command || '').trim();
  validateWorkerCommand(command);
  const cwd = typeof call.args.cwd === 'string' && call.args.cwd.trim() ? call.args.cwd.trim() : '.';
  const timeoutMs = clamp(typeof call.args.timeoutMs === 'number' ? call.args.timeoutMs : 15000, 1000, 25000);
  const maxOutputChars = clamp(typeof call.args.maxOutputChars === 'number' ? call.args.maxOutputChars : 12000, 1000, 20000);
  const expectChanges = call.args.expectChanges === true;
  const confirmed = call.args.confirmed === true;

  if (!confirmed) {
    const reason = typeof call.args.reason === 'string' && call.args.reason.trim()
      ? `\n\nMotivo: ${call.args.reason.trim()}`
      : '';
    return confirm(call, `¿Confirmas ejecutar este comando en el worker del workspace?\n\n\`${command}\`\n\nDirectorio: /workspace/${cwd === '.' ? '' : cwd}${reason}`, {
      command,
      cwd,
      timeoutMs,
      expectChanges
    });
  }

  const result = await fetchNexusJson<{
    requestId: string;
    workspaceId: string;
    ok: boolean;
    command: string;
    cwd: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal?: string | null;
    timedOut?: boolean;
    durationMs: number;
  }>('/agent/run-command', ctx, {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: resolveWorkerWorkspaceId(ctx),
      command,
      cwd,
      timeoutMs,
      maxOutputBytes: maxOutputChars
    })
  }, timeoutMs + 7000);

  const stdout = truncateText(result.stdout || '', maxOutputChars);
  const stderr = truncateText(result.stderr || '', Math.max(1000, Math.floor(maxOutputChars / 2)));
  const summary = result.ok
    ? `Comando ejecutado correctamente en el worker (exit ${result.exitCode ?? 0}).`
    : `El comando terminó con error en el worker (exit ${result.exitCode ?? 'desconocido'}).`;

  return ok(call, summary, {
    command,
    cwd: result.cwd,
    commandOk: result.ok,
    workerWorkspaceId: result.workspaceId,
    stdout,
    stderr,
    exitCode: result.exitCode,
    signal: result.signal || null,
    timedOut: result.timedOut === true,
    durationMs: result.durationMs,
    mayHaveChangedWorkspace: expectChanges
  });
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeWorkerReadPath(rawPath: unknown) {
  const path = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : '.';
  if (path.includes('\0')) throw new Error('path contiene caracteres nulos');
  if (path.startsWith('/')) throw new Error('path debe ser relativo a /workspace');
  if (path.split('/').some((part) => part === '..')) throw new Error('path no puede contener segmentos ".."');
  return path || '.';
}

async function runControlledWorkerCommand(
  ctx: AgentExecutionContext,
  command: string,
  cwd = '.',
  timeoutMs = 10000,
  maxOutputChars = 12000
) {
  return await fetchNexusJson<{
    requestId: string;
    workspaceId: string;
    ok: boolean;
    command: string;
    cwd: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal?: string | null;
    timedOut?: boolean;
    durationMs: number;
  }>('/agent/run-command', ctx, {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: resolveWorkerWorkspaceId(ctx),
      command,
      cwd,
      timeoutMs,
      maxOutputBytes: maxOutputChars
    })
  }, timeoutMs + 7000);
}

async function listWorkerFiles(call: AgentToolCall, ctx: AgentExecutionContext) {
  const path = normalizeWorkerReadPath(call.args.path);
  const maxDepth = clamp(typeof call.args.maxDepth === 'number' ? call.args.maxDepth : 3, 1, 6);
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 80, 1, 200);
  const command = `find ${shellQuote(path)} -maxdepth ${maxDepth} -printf '%y %p\\n' | sort | head -n ${limit}`;
  const result = await runControlledWorkerCommand(ctx, command, '.', 12000, 20000);
  const stdout = truncateText(result.stdout || '', 20000);
  const stderr = truncateText(result.stderr || '', 4000);
  const entries = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const kind = line.slice(0, 1);
      const entryPath = line.slice(2);
      return {
        type: kind === 'd' ? 'directory' : kind === 'f' ? 'file' : 'other',
        path: entryPath
      };
    });

  if (!result.ok) {
    return {
      ok: false,
      name: call.name,
      callId: call.id,
      summary: `No pude listar archivos del worker (exit ${result.exitCode ?? 'desconocido'}).`,
      error: stderr || stdout || 'find falló en el worker',
      data: {
        command,
        cwd: result.cwd,
        stdout,
        stderr,
        exitCode: result.exitCode,
        diagnostic: {
          severity: 'warning',
          message: 'Falló list_worker_files',
          detail: stderr || stdout || 'find falló en el worker',
          code: 'list_worker_files'
        }
      }
    } as AgentToolExecutionResult;
  }

  return ok(call, `Listé ${entries.length} entrada(s) reales del worker en ${path}.`, {
    workerWorkspaceId: result.workspaceId,
    path,
    maxDepth,
    entries,
    stdout,
    stderr,
    command
  });
}

type GitStatusItem = {
  docId: string;
  repoPath: string;
  name?: string | null;
  folder?: string | null;
  status: 'clean' | 'modified' | 'new' | 'unknown' | string;
};

type GitStatusResponse = {
  workspaceId: string;
  repoFullName: string;
  items: GitStatusItem[];
};

async function fetchGitStatus(ctx: AgentExecutionContext) {
  return await fetchAppJson<GitStatusResponse>(
    `/api/workspaces/${encodeURIComponent(ctx.workspaceId)}/git/status`,
    ctx,
    { method: 'GET' },
    20000
  );
}

function summarizeGitStatus(status: GitStatusResponse) {
  const counts = status.items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const changed = status.items.filter((item) => item.status !== 'clean');
  return { counts, changed };
}

async function gitStatus(call: AgentToolCall, ctx: AgentExecutionContext) {
  const status = await fetchGitStatus(ctx);
  const { counts, changed } = summarizeGitStatus(status);
  return ok(call, `Git detectó ${changed.length} cambio(s): ${counts.modified || 0} modificado(s), ${counts.new || 0} nuevo(s), ${counts.unknown || 0} desconocido(s).`, {
    repoFullName: status.repoFullName,
    counts,
    items: status.items
  });
}

async function gitLog(call: AgentToolCall, ctx: AgentExecutionContext) {
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 10, 1, 50);
  const data = await fetchAppJson<{
    repoFullName: string;
    commits: Array<{
      sha: string;
      shortSha: string;
      message: string;
      authorName?: string;
      authorEmail?: string;
      date?: string;
      htmlUrl?: string;
    }>;
  }>(
    `/api/workspaces/${encodeURIComponent(ctx.workspaceId)}/git/log?limit=${limit}`,
    ctx,
    { method: 'GET' },
    15000
  );

  return ok(call, `Leí ${data.commits.length} commit(s) de ${data.repoFullName}.`, data);
}

async function gitCommitWorkspace(call: AgentToolCall, ctx: AgentExecutionContext) {
  const message = String(call.args.message || '').trim();
  if (!message) throw new Error('message es requerido');
  const confirmed = call.args.confirmed === true;
  const explicitIds = Array.isArray(call.args.documentIds)
    ? call.args.documentIds.map(String).map((id) => id.trim()).filter(Boolean)
    : [];
  const status = explicitIds.length > 0 ? null : await fetchGitStatus(ctx);
  const candidateIds = explicitIds.length > 0
    ? explicitIds
    : (status?.items || [])
      .filter((item) => item.status !== 'clean')
      .map((item) => item.docId);

  if (candidateIds.length === 0) {
    return ok(call, 'No hay documentos nuevos o modificados para commitear.', {
      message,
      documentIds: [],
      status: status ? summarizeGitStatus(status) : null
    });
  }

  if (!confirmed) {
    const preview = status
      ? status.items
        .filter((item) => candidateIds.includes(item.docId))
        .slice(0, 8)
        .map((item) => `- ${item.repoPath} (${item.status})`)
        .join('\n')
      : candidateIds.slice(0, 8).map((id) => `- ${id}`).join('\n');
    return confirm(call, `¿Confirmas crear un commit Git con ${candidateIds.length} documento(s)?\n\nMensaje: ${message}\n\n${preview}`, {
      message,
      documentIds: candidateIds
    });
  }

  const events = await fetchAppSseEvents(
    `/api/workspaces/${encodeURIComponent(ctx.workspaceId)}/git/commit`,
    ctx,
    {
      method: 'POST',
      body: JSON.stringify({
        message,
        docIds: candidateIds
      })
    },
    55000
  );
  const errorEvent = events.find((event) => event.event === 'error');
  if (errorEvent) {
    return {
      ok: false,
      name: call.name,
      callId: call.id,
      summary: `Falló el commit Git: ${String(errorEvent.error || 'error desconocido')}`,
      error: String(errorEvent.error || 'error desconocido'),
      data: {
        events,
        diagnostic: {
          severity: 'error',
          message: 'Falló git_commit_workspace',
          detail: String(errorEvent.error || 'error desconocido'),
          code: 'git_commit_workspace'
        }
      }
    } as AgentToolExecutionResult;
  }

  const done = events.find((event) => event.event === 'done');
  const committedCount = typeof done?.committedCount === 'number' ? done.committedCount : 0;
  const failedCount = typeof done?.failedCount === 'number' ? done.failedCount : 0;
  const commitOk = done?.ok !== false && failedCount === 0;
  const summary = commitOk
    ? `Commit Git creado con ${committedCount} archivo(s).`
    : `Commit Git parcial: ${committedCount} archivo(s), ${failedCount} fallo(s).`;

  if (!commitOk) {
    return {
      ok: false,
      name: call.name,
      callId: call.id,
      summary,
      error: summary,
      data: {
        events,
        commit: done || null,
        mayHaveChangedWorkspace: committedCount > 0,
        diagnostic: {
          severity: failedCount > 0 ? 'warning' : 'error',
          message: 'Commit Git incompleto',
          detail: JSON.stringify(done?.errors || events.slice(-3), null, 2),
          code: 'git_commit_workspace'
        }
      }
    } as AgentToolExecutionResult;
  }

  return ok(call, summary, {
    events,
    commit: done || null,
    documentIds: candidateIds,
    mayHaveChangedWorkspace: true
  });
}

async function syncStatus(call: AgentToolCall, ctx: AgentExecutionContext) {
  const [documents, worker, git] = await Promise.all([
    loadWorkspaceDocuments(ctx, MAX_DOC_SCAN),
    fetchWorkerStatus(ctx, 5000),
    fetchGitStatus(ctx).catch((error) => ({ error: getErrorMessage(error) }))
  ]);
  const textDocs = documents.filter((doc) => (doc.type || DocumentType.Text) !== DocumentType.Folder);
  const withStorage = textDocs.filter((doc) => typeof doc.storagePath === 'string' && doc.storagePath.trim());
  const gitSummary = 'items' in git ? summarizeGitStatus(git) : null;
  const pendingGit = gitSummary ? gitSummary.changed.length : null;

  return ok(call, `Sincronización: ${withStorage.length}/${textDocs.length} documento(s) con storage, worker ${worker.worker.online ? 'online' : 'offline'}${pendingGit === null ? '' : `, ${pendingGit} cambio(s) Git pendiente(s)`}.`, {
    documents: {
      total: documents.length,
      textDocuments: textDocs.length,
      withStorage: withStorage.length,
      withoutStorage: textDocs.length - withStorage.length
    },
    worker,
    git: 'items' in git ? {
      repoFullName: git.repoFullName,
      counts: gitSummary?.counts,
      pendingCount: pendingGit,
      items: git.items.slice(0, 100)
    } : git
  });
}

async function reportDebug(call: AgentToolCall) {
  const message = String(call.args.message || '').trim();
  if (!message) throw new Error('message es requerido');
  const rawSeverity = String(call.args.severity || 'info');
  const severity = rawSeverity === 'error' || rawSeverity === 'warning' || rawSeverity === 'hint' ? rawSeverity : 'info';
  const detail = typeof call.args.detail === 'string' ? call.args.detail : undefined;
  const code = typeof call.args.code === 'string' ? call.args.code : undefined;

  return ok(call, `Publiqué debug: ${message}`, {
    diagnostic: {
      severity,
      message,
      detail,
      code: code || 'agent-debug'
    }
  });
}

async function getWorkerStatus(call: AgentToolCall, ctx: AgentExecutionContext) {
  const status = await fetchWorkerStatus(ctx, 5000);
  return ok(
    call,
    status.worker.online
      ? `El worker está online para ${status.workspaceId}.`
      : `No hay worker online para ${status.workspaceId}.`,
    { status }
  );
}

export const WORKER_TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_worker_status: getWorkerStatus,
  run_worker_command: runWorkerCommand,
  list_worker_files: listWorkerFiles,
  sync_status: syncStatus,
  git_status: gitStatus,
  git_log: gitLog,
  git_commit_workspace: gitCommitWorkspace,
  report_debug: reportDebug
};
