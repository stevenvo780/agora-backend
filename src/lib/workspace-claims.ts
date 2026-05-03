/**
 * Syncs Firebase custom claims with workspace membership list.
 *
 * Security rules use `request.auth.token.workspaces` (a map of workspaceId → true)
 * to check membership without expensive get()/exists() calls.
 *
 * Call this whenever a user's workspace membership changes (join, leave, invite accept, remove, delete workspace).
 */
import { adminAuth, adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';

/**
 * Rebuild the `workspaces` custom claim for a user from the source of truth (Firestore).
 * The claim is a map `{ wsId: true }` so `wsId in request.auth.token.workspaces` works in rules.
 */
export async function syncWorkspaceClaims(uid: string): Promise<void> {
  try {
    const snapshot = await adminDb
      .collection('workspaces')
      .where('members', 'array-contains', uid)
      .select() // only need doc IDs
      .get();

    const workspaces: Record<string, boolean> = {};
    snapshot.docs.forEach((doc) => {
      workspaces[doc.id] = true;
    });

    // Preserve existing custom claims (e.g. role, workspaceId for sync-agent)
    const user = await adminAuth.getUser(uid);
    const existingClaims = user.customClaims || {};

    await adminAuth.setCustomUserClaims(uid, {
      ...existingClaims,
      workspaces
    });
  } catch (error) {
    console.warn('Failed to sync workspace claims for', uid, getErrorMessage(error));
  }
}

/**
 * Convenience: sync claims for multiple users (e.g. all members of a workspace).
 */
export async function syncWorkspaceClaimsForMembers(memberUids: string[]): Promise<void> {
  await Promise.allSettled(memberUids.map((uid) => syncWorkspaceClaims(uid)));
}
