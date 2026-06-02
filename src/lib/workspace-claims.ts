/**
 * Syncs Firebase custom claims with workspace membership list.
 *
 * Security rules use `request.auth.token.workspaces` (a map of workspaceId → true)
 * to check membership without expensive get()/exists() calls.
 *
 * Call this whenever a user's workspace membership changes (join, leave, invite accept, remove, delete workspace).
 *
 * Firebase Auth enforces a hard 1000-byte limit on the serialized custom claims
 * object. With many memberships the `{ wsId: true }` map can exceed it, making
 * `setCustomUserClaims` throw for every call — including the one that should add
 * a freshly joined workspace. That was the historical "claims race": the new
 * workspace never landed in the claim and the swallowed error hid the failure.
 */
import { adminAuth, adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';
import {
  buildBoundedWorkspaceClaim,
  type CustomClaims
} from '@/lib/workspace-claims-bounds';

export {
  buildBoundedWorkspaceClaim,
  claimsByteLength,
  CLAIMS_BYTE_LIMIT,
  type CustomClaims
} from '@/lib/workspace-claims-bounds';

/**
 * Rebuild the `workspaces` custom claim for a user from the source of truth (Firestore).
 * The claim is a map `{ wsId: true }` so `wsId in request.auth.token.workspaces` works in rules.
 */
export async function syncWorkspaceClaims(uid: string, priorityId?: string): Promise<void> {
  try {
    const snapshot = await adminDb
      .collection('workspaces')
      .where('members', 'array-contains', uid)
      .select()
      .get();

    const workspaceIds = snapshot.docs.map((doc) => doc.id);

    const user = await adminAuth.getUser(uid);
    const { workspaces: _previous, ...baseClaims } = (user.customClaims || {}) as CustomClaims;

    const { claims, dropped } = buildBoundedWorkspaceClaim(baseClaims, workspaceIds, priorityId);

    if (dropped.length > 0) {
      console.error(
        '[workspace-claims] custom claims over 1000B for',
        uid,
        `— dropped ${dropped.length} of ${workspaceIds.length} memberships to fit`
      );
    }

    await adminAuth.setCustomUserClaims(uid, claims);
  } catch (error) {
    console.error('[workspace-claims] failed to sync for', uid, getErrorMessage(error));
  }
}

/**
 * Convenience: sync claims for multiple users (e.g. all members of a workspace).
 */
export async function syncWorkspaceClaimsForMembers(memberUids: string[]): Promise<void> {
  await Promise.allSettled(memberUids.map((uid) => syncWorkspaceClaims(uid)));
}
