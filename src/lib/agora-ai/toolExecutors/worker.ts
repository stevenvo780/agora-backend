import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, confirm, clamp, truncateText,
  fetchWorkerStatus, fetchNexusJson, fetchAppJson, fetchAppSseEvents,
  resolveWorkerWorkspaceId, loadWorkspaceDocuments,
  getErrorMessage, DocumentType, DEFAULT_PAGE_SIZE
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
    loadWorkspaceDocuments(ctx, DEFAULT_PAGE_SIZE),
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

async function gitDiff(call: AgentToolCall, ctx: AgentExecutionContext) {
  const path = typeof call.args.path === 'string' ? call.args.path.trim() : '';
  const staged = call.args.staged === true;
  const cmd = staged
    ? `cd /workspace && git diff --cached --stat && echo --- && git diff --cached ${path ? `-- ${shellQuote(path)}` : ''} | head -300`
    : `cd /workspace && git diff --stat && echo --- && git diff ${path ? `-- ${shellQuote(path)}` : ''} | head -300`;
  const result = await runControlledWorkerCommand(ctx, cmd);
  return ok(call, `git diff (${staged ? 'staged' : 'unstaged'}${path ? ` · ${path}` : ''}): exit ${result.exitCode ?? 0}.`, {
    diff: result.stdout, stderr: result.stderr, staged, path: path || null, exitCode: result.exitCode
  });
}

async function gitPull(call: AgentToolCall, ctx: AgentExecutionContext) {
  const remote = String(call.args.remote || 'origin').trim() || 'origin';
  const branch = typeof call.args.branch === 'string' ? call.args.branch.trim() : '';
  const cmd = `cd /workspace && git pull ${shellQuote(remote)}${branch ? ` ${shellQuote(branch)}` : ''}`;
  const result = await runControlledWorkerCommand(ctx, cmd, '.', 30000);
  return ok(call, `git pull desde ${remote}${branch ? `/${branch}` : ''}: exit ${result.exitCode ?? 0}.`, {
    output: result.stdout, stderr: result.stderr, exitCode: result.exitCode
  });
}

async function gitPushBranch(call: AgentToolCall, ctx: AgentExecutionContext) {
  const remote = String(call.args.remote || 'origin').trim() || 'origin';
  const branch = String(call.args.branch || '').trim();
  const confirmed = call.args.confirmed === true;
  if (!confirmed) {
    return confirm(call, `¿Hacer git push${branch ? ` de la rama "${branch}"` : ''} hacia ${remote}?`, { remote, branch });
  }
  const cmd = `cd /workspace && git push ${shellQuote(remote)}${branch ? ` ${shellQuote(branch)}` : ''}`;
  const result = await runControlledWorkerCommand(ctx, cmd, '.', 30000);
  return ok(call, `git push hacia ${remote}${branch ? `/${branch}` : ''}: exit ${result.exitCode ?? 0}.`, {
    output: result.stdout, stderr: result.stderr, exitCode: result.exitCode
  });
}

async function gitCreateBranch(call: AgentToolCall, ctx: AgentExecutionContext) {
  const branch = String(call.args.branch || '').trim();
  if (!branch) throw new Error('branch es requerido');
  if (!/^[A-Za-z0-9_./-]+$/.test(branch)) throw new Error('Nombre de branch inválido');
  const cmd = `cd /workspace && git checkout -b ${shellQuote(branch)}`;
  const result = await runControlledWorkerCommand(ctx, cmd);
  return ok(call, `git checkout -b ${branch}: exit ${result.exitCode ?? 0}.`, {
    branch, output: result.stdout, stderr: result.stderr, exitCode: result.exitCode
  });
}

async function gitCheckout(call: AgentToolCall, ctx: AgentExecutionContext) {
  const target = String(call.args.target || '').trim();
  if (!target) throw new Error('target (branch/commit) es requerido');
  if (!/^[A-Za-z0-9_./-]+$/.test(target)) throw new Error('target inválido');
  const cmd = `cd /workspace && git checkout ${shellQuote(target)}`;
  const result = await runControlledWorkerCommand(ctx, cmd);
  return ok(call, `git checkout ${target}: exit ${result.exitCode ?? 0}.`, {
    target, output: result.stdout, stderr: result.stderr, exitCode: result.exitCode
  });
}

async function gitRevertCommit(call: AgentToolCall, ctx: AgentExecutionContext) {
  const sha = String(call.args.sha || '').trim();
  const confirmed = call.args.confirmed === true;
  if (!sha) throw new Error('sha es requerido');
  if (!/^[a-f0-9]{4,40}$/.test(sha)) throw new Error('sha hexadecimal inválido');
  if (!confirmed) {
    return confirm(call, `¿Revertir el commit ${sha} (creará un nuevo commit que deshace ese)?`, { sha });
  }
  const cmd = `cd /workspace && git revert --no-edit ${shellQuote(sha)}`;
  const result = await runControlledWorkerCommand(ctx, cmd);
  return ok(call, `git revert ${sha}: exit ${result.exitCode ?? 0}.`, {
    sha, output: result.stdout, stderr: result.stderr, exitCode: result.exitCode
  });
}

async function readWorkerFile(call: AgentToolCall, ctx: AgentExecutionContext) {
  const path = String(call.args.path || '').trim();
  const maxBytes = typeof call.args.maxBytes === 'number' ? Math.min(Math.max(call.args.maxBytes, 256), 200_000) : 50_000;
  if (!path) throw new Error('path es requerido');
  if (path.includes('..')) throw new Error('path traversal no permitido');
  const cmd = `cd /workspace && head -c ${maxBytes} ${shellQuote(path)}`;
  const result = await runControlledWorkerCommand(ctx, cmd, '.', 8000, maxBytes + 200);
  if (result.exitCode !== 0) {
    return ok(call, `No se pudo leer ${path}: ${result.stderr.slice(0, 200)}`, {
      path, exitCode: result.exitCode, stderr: result.stderr
    });
  }
  return ok(call, `Leí ${result.stdout.length} bytes de /workspace/${path}.`, {
    path, content: result.stdout, bytesRead: result.stdout.length
  });
}

async function writeWorkerFile(call: AgentToolCall, ctx: AgentExecutionContext) {
  const path = String(call.args.path || '').trim();
  const content = String(call.args.content ?? '');
  const confirmed = call.args.confirmed === true;
  if (!path) throw new Error('path es requerido');
  if (path.includes('..')) throw new Error('path traversal no permitido');
  if (content.length > 200_000) throw new Error('content > 200KB no permitido');
  if (!confirmed) {
    return confirm(call, `¿Escribir ${content.length} bytes a /workspace/${path}? (sobrescribe si existe)`, {
      path, bytes: content.length, preview: content.slice(0, 200)
    });
  }
  const dirname = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const cmd = `cd /workspace && ${dirname ? `mkdir -p ${shellQuote(dirname)} && ` : ''}echo ${shellQuote(b64)} | base64 -d > ${shellQuote(path)}`;
  const result = await runControlledWorkerCommand(ctx, cmd, '.', 12000);
  if (result.exitCode !== 0) {
    return ok(call, `Falló al escribir ${path}: ${result.stderr.slice(0, 200)}`, {
      path, exitCode: result.exitCode, stderr: result.stderr
    });
  }
  return ok(call, `Escribí ${content.length} bytes en /workspace/${path}.`, {
    path, bytesWritten: content.length, exitCode: result.exitCode
  });
}

async function tailWorkerLogs(call: AgentToolCall, ctx: AgentExecutionContext) {
  const file = String(call.args.path || '').trim();
  const lines = typeof call.args.lines === 'number' ? Math.min(Math.max(call.args.lines, 1), 500) : 100;
  if (!file) throw new Error('path es requerido (archivo de log)');
  if (file.includes('..')) throw new Error('path traversal no permitido');
  const cmd = `cd /workspace && tail -n ${lines} ${shellQuote(file)}`;
  const result = await runControlledWorkerCommand(ctx, cmd);
  return ok(call, `Últimas ${lines} líneas de ${file} (exit ${result.exitCode ?? 0}).`, {
    path: file, lines, output: result.stdout, exitCode: result.exitCode
  });
}

async function killWorkerProcess(call: AgentToolCall, ctx: AgentExecutionContext) {
  const pid = String(call.args.pid || '').trim();
  const signal = String(call.args.signal || 'TERM').trim();
  const confirmed = call.args.confirmed === true;
  if (!pid || !/^\d+$/.test(pid)) throw new Error('pid numérico es requerido');
  if (!/^(TERM|KILL|HUP|INT|QUIT)$/.test(signal)) throw new Error('signal inválido (TERM|KILL|HUP|INT|QUIT)');
  if (!confirmed) {
    return confirm(call, `¿Enviar SIG${signal} al PID ${pid} en el worker?`, { pid, signal });
  }
  const cmd = `kill -${signal} ${pid}`;
  const result = await runControlledWorkerCommand(ctx, cmd);
  return ok(call, `kill -${signal} ${pid}: exit ${result.exitCode ?? 0}.`, {
    pid, signal, exitCode: result.exitCode, stderr: result.stderr
  });
}

async function restartWorker(call: AgentToolCall, ctx: AgentExecutionContext) {
  const confirmed = call.args.confirmed === true;
  if (!confirmed) {
    return confirm(call, `¿Reiniciar el worker del workspace? Pierdes sesiones de terminal activas.`, { workspaceId: ctx.workspaceId });
  }
  return ok(call, 'restart_worker no expone control directo desde Cloud Run; el daemon agora-host-sync de stev-server reviva containers caídos automáticamente. Si necesitas un restart inmediato, usa run_worker_command con `pkill -f /app/index.js` (el container reinicia con unless-stopped).', {
    workspaceId: ctx.workspaceId,
    notImplementedFully: true,
    suggestion: 'pkill -f /app/index.js dentro del worker, o ssh al host y `docker restart edu-worker-<wsId>`'
  });
}

async function startWorker(call: AgentToolCall, ctx: AgentExecutionContext) {
  return ok(call, 'start_worker requiere acceso sudo al host stev-server (`edu-worker-manager add <wsId>`). El agente desde Cloud Run no tiene esa capacidad; llama al admin para que lo cree.', {
    workspaceId: ctx.workspaceId,
    notImplementedFully: true,
    suggestion: 'edu-worker-manager add <wsId> en stev-server (requiere sudo)'
  });
}

async function listActiveTerminalSessions(call: AgentToolCall, ctx: AgentExecutionContext) {
  const status = await fetchWorkerStatus(ctx, 5000);
  const sessions = Array.isArray((status as Record<string, unknown>).sessions)
    ? (status as { sessions: Array<Record<string, unknown>> }).sessions
    : [];
  return ok(call, `${sessions.length} sesión(es) de terminal activa(s) en ${status.workspaceId}.`, {
    workspaceId: status.workspaceId,
    sessions: sessions.map(s => ({
      id: typeof s.id === 'string' ? s.id : '',
      workspaceName: typeof s.workspaceName === 'string' ? s.workspaceName : null,
      sessionName: typeof s.sessionName === 'string' ? s.sessionName : null,
      ownerUid: typeof s.ownerUid === 'string' ? s.ownerUid : null
    }))
  });
}

async function killTerminalSession(call: AgentToolCall, _ctx: AgentExecutionContext) {
  const sessionId = String(call.args.sessionId || '').trim();
  const confirmed = call.args.confirmed === true;
  if (!sessionId) throw new Error('sessionId es requerido');
  if (!confirmed) {
    return confirm(call, `¿Cerrar la sesión de terminal "${sessionId}"?`, { sessionId });
  }
  // Aprovechamos run_worker_command para enviar señal al PTY del worker:
  // matamos cualquier proceso shell asociado vía pkill por sessionId metadata
  // — el handler real existe en Hub vía socket pero no hay endpoint REST hoy.
  return ok(call, 'Para cerrar la sesión de terminal, el cliente debe emitir disconnect via socket.io desde el panel Terminal. Desde Cloud Run no hay endpoint REST directo; usa list_active_terminal_sessions + el panel UI.', {
    sessionId,
    notImplementedFully: true,
    suggestion: 'el usuario puede cerrar la pestaña del terminal o usar kill_worker_process si conoce el PID'
  });
}

export const WORKER_TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_worker_status: getWorkerStatus,
  run_worker_command: runWorkerCommand,
  list_worker_files: listWorkerFiles,
  sync_status: syncStatus,
  git_status: gitStatus,
  git_log: gitLog,
  git_commit_workspace: gitCommitWorkspace,
  git_diff: gitDiff,
  git_pull: gitPull,
  git_push_branch: gitPushBranch,
  git_create_branch: gitCreateBranch,
  git_checkout: gitCheckout,
  git_revert_commit: gitRevertCommit,
  read_worker_file: readWorkerFile,
  write_worker_file: writeWorkerFile,
  tail_worker_logs: tailWorkerLogs,
  kill_worker_process: killWorkerProcess,
  restart_worker: restartWorker,
  start_worker: startWorker,
  list_active_terminal_sessions: listActiveTerminalSessions,
  kill_terminal_session: killTerminalSession,
  report_debug: reportDebug
};
