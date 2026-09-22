import 'server-only';
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getIronSession, type SessionOptions } from 'iron-session';
import { and, eq, gte, isNull, ne } from 'drizzle-orm';
import { db, schema } from './db';
import { isOtpShapedBearer, isResetShapedBearer, usesMagicLink } from './auth-mode';
import { env, getAuthMode, sessionCookieConfig } from './env';
import { hashPassword, verifyPasswordOrDummy } from './password';
import {
  attachMembershipFromInvite,
  getMembershipForUser,
  isHouseholdEmailAllowed,
  isParentLike,
  type Membership,
} from './households';

export type SessionRole = 'student' | 'parent';

export type SessionData = {
  userId?: number;
  role?: SessionRole;
  email?: string;
  /**
   * Parent-only: when true, a `parent` session is "playing as a student" and
   * gets the full exam flow. Attempts still persist under the parent's own
   * `userId` (never the student's) — this only unlocks the write path and the
   * `ExamApp` surface, it never reassigns ownership. Meaningless for students.
   */
  studentMode?: boolean;
};

// Name + Secure follow SITE_URL (https → Secure `__Host-` cookie; plain http
// → non-Secure `examify_session`). Every set / clear goes through these
// options, so /signin/invalidate and signOut clear the same cookie.
const sessionCookie = sessionCookieConfig();

const sessionOptions: SessionOptions = {
  password: env.AUTH_SECRET,
  cookieName: sessionCookie.name,
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    secure: sessionCookie.secure,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  },
};

/**
 * A signed-in session must still have household membership whose role
 * matches the cookie. Removal (or a stale role) forces re-auth — the
 * 30-day cookie is not a standing grant.
 */
export function sessionMembershipOk(
  session: Pick<SessionData, 'userId' | 'role'>,
  membership: Membership | null,
): boolean {
  if (!session.userId || !session.role) return true;
  if (!membership || membership.userId !== session.userId) return false;
  if (session.role === 'student') return membership.role === 'student';
  return isParentLike(membership.role);
}

/**
 * Raw iron-session (no membership re-check). Use when this request is about
 * to *write* a new session (verify, bootstrap) so a stale cookie cannot
 * redirect away before save.
 */
export async function getRawSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions);
}

export async function getSession() {
  const session = await getRawSession();
  if (session.userId && session.role) {
    const membership = getMembershipForUser(session.userId);
    if (!sessionMembershipOk(session, membership)) {
      // Cookie mutation is illegal during a Server Component render
      // (same reason /signin/verify is a Route Handler). Redirect to a
      // GET handler that can persist the clear so the browser drops the
      // sealed session instead of keeping a dead cookie.
      redirect('/signin/invalidate');
    }
  }
  return session;
}

export async function destroySession(): Promise<void> {
  const session = await getRawSession();
  session.destroy();
}

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 15 * 60 * 1000;

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function generateMagicToken(): { token: string; tokenHash: string; expiresAt: Date } {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const tokenHash = sha256(token);
  return { token, tokenHash, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) };
}

export async function issueMagicLink(
  email: string,
  role: SessionRole,
  opts?: { inviteId?: number },
): Promise<{ id: number; token: string; expiresAt: Date }> {
  const { token, tokenHash, expiresAt } = generateMagicToken();
  const inserted = db
    .insert(schema.magicTokens)
    .values({ email, role, tokenHash, expiresAt, inviteId: opts?.inviteId })
    .returning({ id: schema.magicTokens.id })
    .get();
  if (!inserted) throw new Error('failed to issue magic link');
  return { id: inserted.id, token, expiresAt };
}

const OTP_TTL_MS = TOKEN_TTL_MS;
/**
 * Well-formed wrong guesses per email+role, inside one OTP lifetime, before
 * the challenge is consumed and verification is locked. Issuing a new code
 * does not reset the count — the lock lifts only as failures age out.
 */
export const OTP_GUESS_MAX = 5;
const OTP_ISSUE_HASH_ATTEMPTS = 8;

function otpBearer(email: string, role: SessionRole, code: string): string {
  return `otp:${email}:${role}:${code}`;
}

function resetBearer(email: string, role: SessionRole, code: string): string {
  return `reset:${email}:${role}:${code}`;
}

function otpGuessBucket(email: string, role: SessionRole): string {
  return `otp:${email}:${role}`;
}

function resetGuessBucket(email: string, role: SessionRole): string {
  return `reset:${email}:${role}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  const message = 'message' in error ? String(error.message) : '';
  return code.includes('CONSTRAINT') || /UNIQUE constraint failed/i.test(message);
}

function countOtpGuessFailures(email: string, role: SessionRole, now: number): number {
  const windowStart = now - OTP_TTL_MS;
  return db
    .select({ id: schema.rateLimitEvents.id })
    .from(schema.rateLimitEvents)
    .where(
      and(
        eq(schema.rateLimitEvents.ip, otpGuessBucket(email, role)),
        eq(schema.rateLimitEvents.kind, 'signin'),
        gte(schema.rateLimitEvents.createdAt, new Date(windowStart)),
      ),
    )
    .all().length;
}

function consumeOutstandingOtps(email: string, role: SessionRole, now: number): void {
  db.update(schema.magicTokens)
    .set({ consumedAt: new Date(now), pendingPasswordHash: null })
    .where(
      and(
        eq(schema.magicTokens.email, email),
        eq(schema.magicTokens.role, role),
        isNull(schema.magicTokens.consumedAt),
      ),
    )
    .run();
}

function recordOtpGuessFailure(email: string, role: SessionRole, now: number): void {
  db.insert(schema.rateLimitEvents)
    .values({
      ip: otpGuessBucket(email, role),
      kind: 'signin',
      createdAt: new Date(now),
    })
    .run();
  if (countOtpGuessFailures(email, role, now) >= OTP_GUESS_MAX) {
    consumeOutstandingOtps(email, role, now);
  }
}

/** Cryptographically random 6-digit code (000000–999999). */
export function generateOtpCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Issue a local OTP. Previous unused codes for this email+role are marked
 * consumed so only the latest code works. Insert + revoke run in one
 * transaction; a unique-hash collision retries, and if every attempt fails
 * the rollback leaves the previous unused code intact. The guess bucket is
 * left alone: clearing it here would hand out five fresh guesses per
 * re-issue, turning the lock into a speed bump.
 */
export function issueLocalOtp(
  email: string,
  role: SessionRole,
  opts?: { inviteId?: number; pendingPasswordHash?: string },
): { id: number; code: string; expiresAt: Date } {
  const now = Date.now();
  const expiresAt = new Date(now + OTP_TTL_MS);
  let lastError: unknown;

  for (let attempt = 0; attempt < OTP_ISSUE_HASH_ATTEMPTS; attempt++) {
    const code = generateOtpCode();
    const tokenHash = sha256(otpBearer(email, role, code));
    try {
      // One transaction per attempt: a unique-hash failure rolls back so
      // the previous unused code stays valid. SQLite cannot retry inserts
      // after a constraint error in the same transaction.
      return db.transaction((tx) => {
        const pendingPasswordHash =
          opts?.inviteId != null && opts.pendingPasswordHash ? opts.pendingPasswordHash : null;
        const inserted = tx
          .insert(schema.magicTokens)
          .values({
            email,
            role,
            tokenHash,
            expiresAt,
            inviteId: opts?.inviteId,
            pendingPasswordHash,
          })
          .returning({ id: schema.magicTokens.id })
          .get();
        if (!inserted) throw new Error('failed to issue OTP');

        tx.update(schema.magicTokens)
          .set({ consumedAt: new Date(now), pendingPasswordHash: null })
          .where(
            and(
              eq(schema.magicTokens.email, email),
              eq(schema.magicTokens.role, role),
              isNull(schema.magicTokens.consumedAt),
              ne(schema.magicTokens.id, inserted.id),
            ),
          )
          .run();

        return { id: inserted.id, code, expiresAt };
      });
    } catch (error) {
      lastError = error;
      if (!isUniqueConstraintError(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('failed to issue OTP');
}

/**
 * Mark one issued magic-token (link or OTP) consumed. Used when `sendEmail`
 * fails after issue so a bearer that never reached the mailbox cannot be
 * used later. Targets that row only — a concurrent re-issue for the same
 * email+role must keep its own unused token.
 */
export function invalidateIssuedToken(id: number, now = Date.now()): void {
  db.update(schema.magicTokens)
    .set({ consumedAt: new Date(now), pendingPasswordHash: null })
    .where(and(eq(schema.magicTokens.id, id), isNull(schema.magicTokens.consumedAt)))
    .run();
}

function countBucketGuessFailures(bucket: string, now: number, windowMs = OTP_TTL_MS): number {
  const windowStart = now - windowMs;
  return db
    .select({ id: schema.rateLimitEvents.id })
    .from(schema.rateLimitEvents)
    .where(
      and(
        eq(schema.rateLimitEvents.ip, bucket),
        eq(schema.rateLimitEvents.kind, 'signin'),
        gte(schema.rateLimitEvents.createdAt, new Date(windowStart)),
      ),
    )
    .all().length;
}

/** Outstanding sign-in / reset bearers with no invite. Invite OTPs stay. */
function consumeOutstandingUnaffiliated(email: string, role: SessionRole, now: number): void {
  db.update(schema.magicTokens)
    .set({ consumedAt: new Date(now), pendingPasswordHash: null })
    .where(
      and(
        eq(schema.magicTokens.email, email),
        eq(schema.magicTokens.role, role),
        isNull(schema.magicTokens.consumedAt),
        isNull(schema.magicTokens.inviteId),
      ),
    )
    .run();
}

/**
 * Issue a password-reset code. Previous unused bearers for this email+role
 * that are not invite OTPs are consumed so only the latest reset code works.
 * Does not store a password hash — the new password is applied only when
 * `consumePasswordReset` accepts the code. Like `issueLocalOtp`, re-issue
 * never clears the reset guess bucket.
 */
export function issuePasswordResetOtp(
  email: string,
  role: SessionRole,
): { id: number; code: string; expiresAt: Date } {
  const now = Date.now();
  const expiresAt = new Date(now + OTP_TTL_MS);
  let lastError: unknown;

  for (let attempt = 0; attempt < OTP_ISSUE_HASH_ATTEMPTS; attempt++) {
    const code = generateOtpCode();
    const tokenHash = sha256(resetBearer(email, role, code));
    try {
      return db.transaction((tx) => {
        const inserted = tx
          .insert(schema.magicTokens)
          .values({ email, role, tokenHash, expiresAt })
          .returning({ id: schema.magicTokens.id })
          .get();
        if (!inserted) throw new Error('failed to issue password reset');

        tx.update(schema.magicTokens)
          .set({ consumedAt: new Date(now), pendingPasswordHash: null })
          .where(
            and(
              eq(schema.magicTokens.email, email),
              eq(schema.magicTokens.role, role),
              isNull(schema.magicTokens.consumedAt),
              isNull(schema.magicTokens.inviteId),
              ne(schema.magicTokens.id, inserted.id),
            ),
          )
          .run();

        return { id: inserted.id, code, expiresAt };
      });
    } catch (error) {
      lastError = error;
      if (!isUniqueConstraintError(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('failed to issue password reset');
}

/**
 * Consume a password-reset code and replace `users.password_hash` in the
 * same transaction. Does not create a user, attach membership, or stamp
 * `emailVerifiedAt`. A correct code for someone who is no longer a member
 * is consumed and does not count as a guess. Wrong codes use a separate
 * 5-guess bucket from sign-in OTPs. While that bucket is full every code —
 * even the right one — returns `locked`.
 */
export function consumePasswordReset(
  email: string,
  role: SessionRole,
  code: string,
  password: string,
): ConsumeResult {
  const trimmed = code.trim();
  const normalised = email.trim().toLowerCase();
  if (!/^\d{6}$/.test(trimmed)) {
    return { ok: false, reason: 'not-found' };
  }

  const now = Date.now();
  const bucket = resetGuessBucket(normalised, role);
  if (countBucketGuessFailures(bucket, now) >= OTP_GUESS_MAX) {
    consumeOutstandingUnaffiliated(normalised, role, now);
    return { ok: false, reason: 'locked' };
  }

  const tokenHash = sha256(resetBearer(normalised, role, trimmed));
  let result: ConsumeResult;
  try {
    result = db.transaction((tx) => {
      const row = tx
        .select()
        .from(schema.magicTokens)
        .where(
          and(
            eq(schema.magicTokens.tokenHash, tokenHash),
            isNull(schema.magicTokens.consumedAt),
            gte(schema.magicTokens.expiresAt, new Date(now)),
          ),
        )
        .get();

      if (!row) {
        const anyRow = tx
          .select()
          .from(schema.magicTokens)
          .where(eq(schema.magicTokens.tokenHash, tokenHash))
          .get();
        if (!anyRow) return { ok: false, reason: 'not-found' as const };
        if (anyRow.consumedAt) return { ok: false, reason: 'used' as const };
        return { ok: false, reason: 'expired' as const };
      }

      if (row.inviteId != null || row.pendingPasswordHash) {
        throw new ConsumeRollback({ ok: false, reason: 'invite-invalid' });
      }

      const existing = tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, normalised))
        .get();
      const membership = existing
        ? tx
            .select()
            .from(schema.householdMembers)
            .where(eq(schema.householdMembers.userId, existing.id))
            .get()
        : undefined;
      const allowed = Boolean(
        existing &&
        membership &&
        (role === 'student' ? membership.role === 'student' : isParentLike(membership.role)),
      );

      tx.update(schema.magicTokens)
        .set({ consumedAt: new Date(now), pendingPasswordHash: null })
        .where(eq(schema.magicTokens.id, row.id))
        .run();

      if (!allowed || !existing) {
        return { ok: false, reason: 'not-member' as const };
      }

      const passwordHash = hashPassword(password);
      tx.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, existing.id)).run();

      return { ok: true, userId: existing.id, role, email: existing.email, isNew: false };
    });
  } catch (error) {
    if (error instanceof ConsumeRollback) return error.result;
    throw error;
  }

  if (!result.ok && result.reason !== 'not-member' && result.reason !== 'invite-invalid') {
    recordResetGuessFailure(normalised, role, now);
  }
  return result;
}

function recordResetGuessFailure(email: string, role: SessionRole, now: number): void {
  const bucket = resetGuessBucket(email, role);
  db.insert(schema.rateLimitEvents)
    .values({ ip: bucket, kind: 'signin', createdAt: new Date(now) })
    .run();
  if (countBucketGuessFailures(bucket, now) >= OTP_GUESS_MAX) {
    consumeOutstandingUnaffiliated(email, role, now);
  }
}

/**
 * Consumes a local OTP for an email and role. Malformed codes fail without
 * counting as guesses; after five well-formed failures within the OTP lifetime,
 * outstanding codes for that email and role are invalidated and every code —
 * even a correct one from a later re-issue — returns `locked` until the
 * failures age out.
 * `invite-invalid` is not a guess — a leftover sign-in OTP (or a revoked
 * invite) must not burn the 5-guess lock. Setting a password is invite-bound
 * inside `consumeHashedBearer` (defense in depth; `requireInviteId` stays
 * at the complete call site).
 */
export function consumeLocalOtp(
  email: string,
  role: SessionRole,
  code: string,
  opts?: { passwordHash?: string; requireInviteId?: boolean },
): ConsumeResult {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) {
    consumeHashedBearer(`otp:${email}:${role}:invalid`);
    return { ok: false, reason: 'not-found' };
  }

  const now = Date.now();
  if (countOtpGuessFailures(email, role, now) >= OTP_GUESS_MAX) {
    consumeOutstandingOtps(email, role, now);
    consumeHashedBearer(otpBearer(email, role, trimmed));
    return { ok: false, reason: 'locked' };
  }

  const result = consumeHashedBearer(otpBearer(email, role, trimmed), opts);
  if (!result.ok && result.reason !== 'invite-invalid') {
    recordOtpGuessFailure(email, role, now);
  }
  return result;
}

/** Failed password sign-ins per email (every role) before the account is locked. */
export const PASSWORD_FAILURE_MAX = 10;
/** Sliding window for `PASSWORD_FAILURE_MAX`. */
export const PASSWORD_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Per-account bucket in `rate_limit_events`, keyed by the normalised email
 * only so every role (and every client IP) shares it. Recorded for unknown
 * emails too, so locking reveals nothing about membership.
 */
function passwordFailureBucket(email: string): string {
  return `pw:${email.trim().toLowerCase()}`;
}

/** True while `email` has `PASSWORD_FAILURE_MAX` failures inside the window. */
export function isPasswordSignInLocked(email: string, now = Date.now()): boolean {
  return (
    countBucketGuessFailures(passwordFailureBucket(email), now, PASSWORD_FAILURE_WINDOW_MS) >=
    PASSWORD_FAILURE_MAX
  );
}

export function recordPasswordFailure(email: string, now = Date.now()): void {
  db.insert(schema.rateLimitEvents)
    .values({ ip: passwordFailureBucket(email), kind: 'signin', createdAt: new Date(now) })
    .run();
}

export function clearPasswordFailures(email: string): void {
  db.delete(schema.rateLimitEvents)
    .where(
      and(
        eq(schema.rateLimitEvents.ip, passwordFailureBucket(email)),
        eq(schema.rateLimitEvents.kind, 'signin'),
      ),
    )
    .run();
}

/**
 * Email + password + role. Always spends a password-hash compare (dummy
 * when the user or hash is missing) so unknown emails and wrong passwords
 * look the same. Wrong role also fails closed after the compare. The
 * per-account lock (`isPasswordSignInLocked`) is checked by the caller
 * before this runs, so a locked account costs no scrypt.
 */
export function authenticatePassword(
  email: string,
  password: string,
  role: SessionRole,
): { ok: true; userId: number; role: SessionRole; email: string } | { ok: false } {
  const normalised = email.trim().toLowerCase();
  const user = db.select().from(schema.users).where(eq(schema.users.email, normalised)).get();
  const passwordOk = verifyPasswordOrDummy(password, user?.passwordHash);
  if (!user || !passwordOk) return { ok: false };
  if (!isHouseholdEmailAllowed(role, normalised)) return { ok: false };
  return { ok: true, userId: user.id, role, email: user.email };
}

/**
 * `locked` comes only from the OTP / reset guess locks (`consumeLocalOtp`,
 * `consumePasswordReset`); callers surface it as `rate_limited`.
 */
export type ConsumeResult =
  | { ok: true; userId: number; role: SessionRole; email: string; isNew: boolean }
  | {
      ok: false;
      reason: 'not-found' | 'expired' | 'used' | 'invite-invalid' | 'not-member' | 'locked';
    };

class ConsumeRollback extends Error {
  constructor(readonly result: ConsumeResult) {
    super('consume-rollback');
  }
}

/**
 * Magic-link consume path used by `/signin/verify`. Refuses OTP-shaped
 * bearers (those are `verifyLocalOtp` only) and ignores leftover link
 * tokens when AUTH_MODE is not magic-link.
 */
export function consumeMagicToken(token: string): ConsumeResult {
  if (!usesMagicLink(getAuthMode()) || isOtpShapedBearer(token) || isResetShapedBearer(token)) {
    sha256(token);
    return { ok: false, reason: 'not-found' };
  }
  return consumeHashedBearer(token);
}

/**
 * Consume a hashed bearer: validate, mark consumed, get-or-create the user.
 * All-or-nothing inside a transaction so a partial failure can't issue a
 * session without persisting the user. The role the link was issued for is
 * carried on the token row and returned so the caller can set `session.role`.
 * Setting a password (or `requireInviteId`) refuses tokens with no
 * `invite_id` (rollback, unused) — not only at the call site.
 */
function consumeHashedBearer(
  token: string,
  opts?: { passwordHash?: string; requireInviteId?: boolean },
): ConsumeResult {
  const tokenHash = sha256(token);
  const now = Date.now();
  const passwordHash = opts?.passwordHash;

  try {
    return db.transaction((tx) => {
      const row = tx
        .select()
        .from(schema.magicTokens)
        .where(
          and(
            eq(schema.magicTokens.tokenHash, tokenHash),
            isNull(schema.magicTokens.consumedAt),
            gte(schema.magicTokens.expiresAt, new Date(now)),
          ),
        )
        .get();

      if (!row) {
        const anyRow = tx
          .select()
          .from(schema.magicTokens)
          .where(eq(schema.magicTokens.tokenHash, tokenHash))
          .get();
        if (!anyRow) return { ok: false, reason: 'not-found' as const };
        if (anyRow.consumedAt) return { ok: false, reason: 'used' as const };
        return { ok: false, reason: 'expired' as const };
      }

      const pendingHash = row.pendingPasswordHash ?? undefined;
      // Password-invite complete is invite-bound: a leftover sign-in OTP
      // (no invite_id) must not stamp emailVerifiedAt or set a password.
      // A pending hash on a non-invite row is the same refusal. Require-
      // invite complete ignores a caller-supplied hash and uses only the
      // hash stored on this row at issue time.
      if (row.inviteId == null && (pendingHash || passwordHash || opts?.requireInviteId)) {
        throw new ConsumeRollback({ ok: false, reason: 'invite-invalid' });
      }
      if (opts?.requireInviteId && !pendingHash) {
        throw new ConsumeRollback({ ok: false, reason: 'invite-invalid' });
      }
      const hashToStore = opts?.requireInviteId ? pendingHash : (pendingHash ?? passwordHash);

      tx.update(schema.magicTokens)
        .set({ consumedAt: new Date(now), pendingPasswordHash: null })
        .where(eq(schema.magicTokens.id, row.id))
        .run();

      const existing = tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, row.email))
        .get();

      let userId: number;
      let isNew = false;
      if (existing) {
        const patch: { emailVerifiedAt?: Date; passwordHash?: string } = {};
        if (!existing.emailVerifiedAt) patch.emailVerifiedAt = new Date(now);
        if (hashToStore) patch.passwordHash = hashToStore;
        if (Object.keys(patch).length > 0) {
          tx.update(schema.users).set(patch).where(eq(schema.users.id, existing.id)).run();
        }
        userId = existing.id;
      } else {
        const inserted = tx
          .insert(schema.users)
          .values({
            email: row.email,
            emailVerifiedAt: new Date(now),
            ...(hashToStore ? { passwordHash: hashToStore } : {}),
          })
          .returning({ id: schema.users.id })
          .get();
        if (!inserted) throw new Error('failed to create user');
        userId = inserted.id;
        isNew = true;
      }

      if (row.inviteId != null) {
        const attached = attachMembershipFromInvite(tx, row.inviteId, userId, row.email, now);
        if (!attached.ok) {
          throw new ConsumeRollback({ ok: false, reason: 'invite-invalid' });
        }
      }

      return { ok: true, userId, role: row.role, email: row.email, isNew };
    });
  } catch (error) {
    if (error instanceof ConsumeRollback) return error.result;
    throw error;
  }
}

/**
 * Constant-time string compare. Both inputs are hashed to fixed-length
 * SHA-256 digests so `timingSafeEqual` doesn't leak length, and the
 * comparison itself runs in time independent of how many leading bytes
 * happen to match.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}
