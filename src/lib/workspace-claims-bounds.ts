/**
 * Pure helpers for bounding Firebase custom claims under the hard 1000-byte
 * limit. Kept free of firebase-admin imports so it is trivially unit-testable
 * and so the byte-bound logic can be reasoned about in isolation.
 */

export const CLAIMS_BYTE_LIMIT = 1000;

export type CustomClaims = Record<string, unknown>;

export function claimsByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Build the final custom claims object guaranteeing the serialized size stays
 * under Firebase's 1000-byte limit.
 *
 * The membership map is dropped deterministically (sorted ascending by id, so
 * the kept set is stable across runs) until the whole claims payload fits. The
 * `workspaces` key is always merged last so non-membership claims (role,
 * workspaceId for the sync-agent) are never sacrificed.
 *
 * Dropping a membership entry is fail-closed: the affected (non-personal)
 * workspace simply falls back to denied in the security rules, never to granted.
 * Personal workspaces (`personal_*`) are validated against `auth.uid` directly
 * and never depend on this claim.
 */
export function buildBoundedWorkspaceClaim(
  baseClaims: CustomClaims,
  workspaceIds: readonly string[],
  priorityId?: string
): { claims: CustomClaims; included: string[]; dropped: string[] } {
  const others = [...workspaceIds].filter((id) => id !== priorityId).sort();
  const sorted = priorityId !== undefined && workspaceIds.includes(priorityId)
    ? [priorityId, ...others]
    : others;
  const included: string[] = [...sorted];

  const make = (ids: readonly string[]): CustomClaims => {
    const workspaces: Record<string, boolean> = {};
    for (const id of ids) workspaces[id] = true;
    return { ...baseClaims, workspaces };
  };

  while (included.length > 0 && claimsByteLength(make(included)) > CLAIMS_BYTE_LIMIT) {
    included.pop();
  }

  const claims = make(included);
  const includedSet = new Set(included);
  const dropped = sorted.filter((id) => !includedSet.has(id));
  return { claims, included, dropped };
}
