import 'server-only';
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { getIronSession, type SessionOptions } from 'iron-session';
import { and, eq, gte, isNull } from 'drizzle-orm';
import { db, schema } from './db';
import { env, isProd } from './env';

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

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions);
}

export async function destroySession(): Promise<void> {
  const session = await getSession();
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
): Promise<{ token: string; expiresAt: Date }> {
  const { token, tokenHash, expiresAt } = generateMagicToken();
  db.insert(schema.magicTokens).values({ email, role, tokenHash, expiresAt }).run();
  return { token, expiresAt };
}

export type ConsumeResult =
  | { ok: true; userId: number; role: SessionRole; email: string; isNew: boolean }
  | { ok: false; reason: 'not-found' | 'expired' | 'used' };

/**
 * Consume a magic-link token: validate, mark consumed, get-or-create the user.
 * All-or-nothing inside a transaction so a partial failure can't issue a
 * session without persisting the user. The role the link was issued for is
 * carried on the token row and returned so the caller can set `session.role`.
 */
export function consumeMagicToken(token: string): ConsumeResult {
  const tokenHash = sha256(token);
  const now = Date.now();

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

    const existing = tx.select().from(schema.users).where(eq(schema.users.email, row.email)).get();

    if (existing) {
      if (!existing.emailVerifiedAt) {
        tx.update(schema.users)
          .set({ emailVerifiedAt: new Date(now) })
          .where(eq(schema.users.id, existing.id))
          .run();
      }
      return { ok: true, userId: existing.id, role: row.role, email: row.email, isNew: false };
    }

    const inserted = tx
      .insert(schema.users)
      .values({ email: row.email, emailVerifiedAt: new Date(now) })
      .returning({ id: schema.users.id })
      .get();

    if (!inserted) throw new Error('failed to create user');
    return { ok: true, userId: inserted.id, role: row.role, email: row.email, isNew: true };
  });
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
