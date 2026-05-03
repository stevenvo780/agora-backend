export enum WorkspaceType {
  Personal = 'personal',
  Shared = 'shared'
}

export type WorkspaceTypeId = `${WorkspaceType}`;

export const PERSONAL_WORKSPACE_ID = WorkspaceType.Personal;

const WORKSPACE_TYPE_SET = new Set<WorkspaceTypeId>(Object.values(WorkspaceType));

export const isWorkspaceType = (value: string): value is WorkspaceTypeId =>
  WORKSPACE_TYPE_SET.has(value as WorkspaceTypeId);

export const isPersonalWorkspaceId = (value: string | null | undefined): boolean =>
  !value
  || value === PERSONAL_WORKSPACE_ID
  || (typeof value === 'string' && value.startsWith(`${PERSONAL_WORKSPACE_ID}:`));
