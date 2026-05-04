import {
  isForgejoConfigured, listUserRepos, repoNameForWorkspace,
  provisionWorkspaceRepo, getForgejoOrg, getForgejoApiUrl
} from '@/lib/forgejo';
import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, fetchWorkspaceDoc, isPersonalWorkspaceId
} from './shared';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

async function getRepoInfo(call: AgentToolCall, ctx: AgentExecutionContext) {
  if (!isForgejoConfigured()) {
    return ok(call, 'Forgejo no está configurado en este backend.', { configured: false });
  }
  const targetWs = String(call.args.workspaceId || ctx.workspaceId || '').trim();
  if (!targetWs) throw new Error('workspaceId es requerido');
  const ownerUid = isPersonalWorkspaceId(targetWs)
    ? ctx.uid
    : (typeof (await fetchWorkspaceDoc(targetWs, ctx.uid)).ownerId === 'string'
        ? (await fetchWorkspaceDoc(targetWs, ctx.uid)).ownerId as string
        : ctx.uid);
  const repoName = repoNameForWorkspace(targetWs, ownerUid);
  return ok(call, `Repo Forgejo del workspace: ${getForgejoOrg()}/${repoName}`, {
    org: getForgejoOrg(),
    repoName,
    apiUrl: getForgejoApiUrl(),
    cloneHint: `git clone <FORGEJO_URL>/${getForgejoOrg()}/${repoName}.git`
  });
}

async function listWorkspaceRepos(call: AgentToolCall, ctx: AgentExecutionContext) {
  if (!isForgejoConfigured()) {
    return ok(call, 'Forgejo no está configurado en este backend.', { configured: false, repos: [] });
  }
  const repos = await listUserRepos(ctx.uid).catch(() => []);
  return ok(call, `${repos.length} repo(s) Forgejo accesibles para este usuario.`, {
    repos: repos.map(r => ({
      fullName: r.full_name,
      htmlUrl: r.html_url,
      cloneUrl: r.clone_url,
      sshUrl: r.ssh_url,
      private: r.private
    }))
  });
}

async function provisionWorkspaceGit(call: AgentToolCall, ctx: AgentExecutionContext) {
  if (!isForgejoConfigured()) {
    return ok(call, 'Forgejo no está configurado.', { configured: false });
  }
  const targetWs = String(call.args.workspaceId || ctx.workspaceId || '').trim();
  if (!targetWs) throw new Error('workspaceId es requerido');
  const workspace = isPersonalWorkspaceId(targetWs)
    ? null
    : await fetchWorkspaceDoc(targetWs, ctx.uid);
  const result = await provisionWorkspaceRepo({
    workspaceId: targetWs,
    workspaceName: typeof workspace?.name === 'string' ? workspace.name : 'Workspace personal',
    ownerUid: ctx.uid,
    email: ctx.email ?? undefined
  });
  return ok(call, `Provisión Forgejo: ${result.created ? 'creado' : 'ya existía'}: ${result.repo.full_name}`, {
    workspaceId: targetWs,
    created: result.created,
    repoFullName: result.repo.full_name,
    htmlUrl: result.repo.html_url,
    cloneUrl: result.repo.clone_url
  });
}

export const FORGEJO_TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_repo_info: getRepoInfo,
  list_workspace_repos: listWorkspaceRepos,
  provision_workspace_git: provisionWorkspaceGit
};
