import crypto from 'node:crypto';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password-policy';

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH };

const KEYLEN = 32;
const SCRYPT = { N: 16_384, r: 8, p: 1 } as const;

/** Precomputed hash so unknown-user checks still do scrypt work. */
const DUMMY_HASH = hashPassword('examify-dummy-password-not-a-real-user');

export function passwordMeetsPolicy(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

/**
 * PHC-like encoding: `scrypt$N$r$p$salt$hash` (salt + hash are base64url).
 * Node's built-in scrypt — no extra native dependency.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

/**
 * Verifies a password against the stored scrypt encoding. Malformed hashes and
 * derivation failures are treated as non-matches.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    hashPassword(password);
    return false;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64url');
    expected = Buffer.from(parts[5] ?? '', 'base64url');
  } catch {
    hashPassword(password);
    return false;
  }
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || salt.length === 0) {
    hashPassword(password);
    return false;
  }
  if (expected.length === 0) {
    hashPassword(password);
    return false;
  }
  try {
    const derived = crypto.scryptSync(password, salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Verify against a stored hash, or a dummy hash when the user / hash is
 * missing, so "unknown email" and "wrong password" take similar time.
 */
export function verifyPasswordOrDummy(
  password: string,
  stored: string | null | undefined,
): boolean {
  if (!stored) {
    verifyPassword(password, DUMMY_HASH);
    return false;
  }
  return verifyPassword(password, stored);
}
