import crypto from 'crypto';
import type { UserRecord } from 'firebase-admin/auth';
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '@/lib/firebase-admin';
import { getErrorCode, withErrorCode } from '@/lib/error-utils';

const USER_EMAIL_INDEX_COLLECTION = 'userEmails';
const FIREBASE_AUTH_USER_NOT_FOUND = 'auth/user-not-found';
const FIREBASE_AUTH_EMAIL_EXISTS = 'auth/email-already-exists';

export type StoredUserRecord = {
  email?: string;
  emailNormalized?: string;
  passwordHash?: string;
  displayName?: string;
  photoURL?: string | null;
  role?: string;
};

export type UserLookupResult = {
  id: string;
  ref: FirebaseFirestore.DocumentReference;
  data: StoredUserRecord;
  normalizedEmail: string;
};

export const normalizeEmailAddress = (value: string) => value.trim().toLowerCase();

const isFirebaseAuthUserNotFound = (error: unknown) =>
  getErrorCode(error) === FIREBASE_AUTH_USER_NOT_FOUND;

const createTemporaryPassword = () => `Tmp1!${crypto.randomBytes(18).toString('base64url')}`;

const getUserEmailIndexRef = (normalizedEmail: string) =>
  adminDb.collection(USER_EMAIL_INDEX_COLLECTION).doc(normalizedEmail);

export const backfillUserEmailIndex = async (
  userRef: FirebaseFirestore.DocumentReference,
  normalizedEmail: string,
  userData?: StoredUserRecord
) => {
  const emailRef = getUserEmailIndexRef(normalizedEmail);
  const batch = adminDb.batch();
  const nowIso = new Date().toISOString();

  batch.set(emailRef, {
    uid: userRef.id,
    email: normalizedEmail,
    updatedAt: nowIso
  }, { merge: true });

  if (userData?.emailNormalized !== normalizedEmail) {
    batch.set(userRef, {
      emailNormalized: normalizedEmail,
      updatedAt: nowIso
    }, { merge: true });
  }

  await batch.commit();
};

const getSingleUserFromSnapshots = (
  snapshots: QueryDocumentSnapshot[]
): QueryDocumentSnapshot | null => {
  if (snapshots.length === 0) return null;

  const unique = new Map<string, QueryDocumentSnapshot>();
  snapshots.forEach((snap) => unique.set(snap.id, snap));

  if (unique.size > 1) {
    throw withErrorCode(new Error('Multiple user accounts found for this email'), FIREBASE_AUTH_EMAIL_EXISTS);
  }

  return snapshots[0] ?? null;
};

export const findUserByEmail = async (email: string): Promise<UserLookupResult | null> => {
  const rawEmail = email.trim();
  const normalizedEmail = normalizeEmailAddress(email);
  if (!normalizedEmail) return null;

  const emailRef = getUserEmailIndexRef(normalizedEmail);
  const indexedSnap = await emailRef.get();

  if (indexedSnap.exists) {
    const data = indexedSnap.data() as { uid?: unknown } | undefined;
    if (typeof data?.uid === 'string' && data.uid.trim()) {
      const userRef = adminDb.collection('users').doc(data.uid);
      const userSnap = await userRef.get();
      if (userSnap.exists) {
        const userData = (userSnap.data() ?? {}) as StoredUserRecord;
        if (userData.emailNormalized !== normalizedEmail) {
          await backfillUserEmailIndex(userRef, normalizedEmail, userData);
        }
        return {
          id: userSnap.id,
          ref: userRef,
          data: {
            ...userData,
            emailNormalized: normalizedEmail
          },
          normalizedEmail
        };
      }
    }

    await emailRef.delete().catch(() => {});
  }

  const usersRef = adminDb.collection('users');
  const matchedSnapshots: QueryDocumentSnapshot[] = [];
  const queries = [
    usersRef.where('emailNormalized', '==', normalizedEmail).limit(2),
    usersRef.where('email', '==', normalizedEmail).limit(2)
  ];

  if (rawEmail && rawEmail !== normalizedEmail) {
    queries.push(usersRef.where('email', '==', rawEmail).limit(2));
  }

  const results = await Promise.all(queries.map(q => q.get()));
  for (const snap of results) {
    matchedSnapshots.push(...snap.docs);
  }

  const userSnap = getSingleUserFromSnapshots(matchedSnapshots);
  if (!userSnap) return null;

  const userData = (userSnap.data() ?? {}) as StoredUserRecord;
  await backfillUserEmailIndex(userSnap.ref, normalizedEmail, userData);

  return {
    id: userSnap.id,
    ref: userSnap.ref,
    data: {
      ...userData,
      emailNormalized: normalizedEmail
    },
    normalizedEmail
  };
};

const updateFirebaseAuthUser = async (
  user: UserRecord,
  normalizedEmail: string,
  password?: string
) => {
  const updates: { email?: string; password?: string } = {};

  if (user.email?.trim().toLowerCase() !== normalizedEmail) {
    updates.email = normalizedEmail;
  }

  if (password) {
    updates.password = password;
  }

  if (Object.keys(updates).length > 0) {
    await adminAuth.updateUser(user.uid, updates);
  }
};

export const ensureFirebaseAuthUser = async (params: {
  uid: string;
  email: string;
  password?: string;
}) => {
  const normalizedEmail = normalizeEmailAddress(params.email);
  if (!params.uid || !normalizedEmail) {
    throw new Error('User uid and email are required');
  }

  try {
    const existing = await adminAuth.getUser(params.uid);
    await updateFirebaseAuthUser(existing, normalizedEmail, params.password);
    return;
  } catch (error) {
    if (!isFirebaseAuthUserNotFound(error)) {
      throw error;
    }
  }

  try {
    const existingByEmail = await adminAuth.getUserByEmail(normalizedEmail);
    if (existingByEmail.uid !== params.uid) {
      throw withErrorCode(
        new Error('Email already linked to another authentication account'),
        FIREBASE_AUTH_EMAIL_EXISTS
      );
    }

    await updateFirebaseAuthUser(existingByEmail, normalizedEmail, params.password);
    return;
  } catch (error) {
    if (!isFirebaseAuthUserNotFound(error)) {
      throw error;
    }
  }

  await adminAuth.createUser({
    uid: params.uid,
    email: normalizedEmail,
    password: params.password || createTemporaryPassword()
  });
};
