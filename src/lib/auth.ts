import 'server-only';
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getIronSession, type SessionOptions } from 'iron-session';
import { and, eq, gte, isNull } from 'drizzle-orm';
import { db, schema } from './db';
import { env, isProd } from './env';
import { verifyPasswordOrDummy } from './password';
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

const sessionOptions: SessionOptions = {
  password: env.AUTH_SECRET,
  cookieName: env.SESSION_COOKIE_NAME,
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
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
): Promise<{ token: string; expiresAt: Date }> {
  const { token, tokenHash, expiresAt } = generateMagicToken();
  db.insert(schema.magicTokens)
    .values({ email, role, tokenHash, expiresAt, inviteId: opts?.inviteId })
    .run();
  return { token, expiresAt };
}

const OTP_TTL_MS = TOKEN_TTL_MS;

function otpBearer(email: string, role: SessionRole, code: string): string {
  return `otp:${email}:${role}:${code}`;
}

/** Cryptographically random 6-digit code (000000–999999). */
export function generateOtpCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Issue a local OTP. Previous unused codes for this email+role are marked
 * consumed so only the latest code works. The bearer stored hashed is
 * `otp:{email}:{role}:{code}` so codes do not collide across users.
 */
export function issueLocalOtp(
  email: string,
  role: SessionRole,
  opts?: { inviteId?: number },
): { code: string; expiresAt: Date } {
  const now = Date.now();
  db.update(schema.magicTokens)
    .set({ consumedAt: new Date(now) })
    .where(
      and(
        eq(schema.magicTokens.email, email),
        eq(schema.magicTokens.role, role),
        isNull(schema.magicTokens.consumedAt),
      ),
    )
    .run();

  const code = generateOtpCode();
  const tokenHash = sha256(otpBearer(email, role, code));
  const expiresAt = new Date(now + OTP_TTL_MS);
  db.insert(schema.magicTokens)
    .values({ email, role, tokenHash, expiresAt, inviteId: opts?.inviteId })
    .run();
  return { code, expiresAt };
}

export function consumeLocalOtp(email: string, role: SessionRole, code: string): ConsumeResult {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) {
    consumeMagicToken(`otp:${email}:${role}:invalid`);
    return { ok: false, reason: 'not-found' };
  }
  return consumeMagicToken(otpBearer(email, role, trimmed));
}

/**
 * Email + password + role. Always spends a password-hash compare (dummy
 * when the user or hash is missing) so unknown emails and wrong passwords
 * look the same. Wrong role also fails closed after the compare.
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

export type ConsumeResult =
  | { ok: true; userId: number; role: SessionRole; email: string; isNew: boolean }
  | { ok: false; reason: 'not-found' | 'expired' | 'used' | 'invite-invalid' };

class ConsumeRollback extends Error {
  constructor(readonly result: ConsumeResult) {
    super('consume-rollback');
  }
}

/**
 * Consume a magic-link token: validate, mark consumed, get-or-create the user.
 * All-or-nothing inside a transaction so a partial failure can't issue a
 * session without persisting the user. The role the link was issued for is
 * carried on the token row and returned so the caller can set `session.role`.
 */
export function consumeMagicToken(token: string): ConsumeResult {
  const tokenHash = sha256(token);
  const now = Date.now();

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

      tx.update(schema.magicTokens)
        .set({ consumedAt: new Date(now) })
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
        if (!existing.emailVerifiedAt) {
          tx.update(schema.users)
            .set({ emailVerifiedAt: new Date(now) })
            .where(eq(schema.users.id, existing.id))
            .run();
        }
        userId = existing.id;
      } else {
        const inserted = tx
          .insert(schema.users)
          .values({ email: row.email, emailVerifiedAt: new Date(now) })
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
