import 'server-only';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db, schema } from './db';
import { env } from './env';

export type RateLimitKind = 'signin';

type LimitConfig = { max: number; windowMs: number };

function configFor(_kind: RateLimitKind): LimitConfig {
  return { max: env.RATE_LIMIT_SIGNIN_MAX, windowMs: env.RATE_LIMIT_SIGNIN_WINDOW_MS };
}

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
  windowMs: number;
  max: number;
};

/**
 * Sliding-window rate limit. Counts events in `[now - windowMs, now]` for the
 * given (ip, kind). If under the cap, inserts a new event and returns ok=true.
 * Lazily purges this IP's rows older than 7 days on each call.
 */
export function checkRateLimit(ip: string, kind: RateLimitKind, now = Date.now()): RateLimitResult {
  const { max, windowMs } = configFor(kind);
  const windowStart = now - windowMs;
  const purgeBefore = now - 7 * 24 * 3_600_000;

  return db.transaction((tx) => {
    tx.delete(schema.rateLimitEvents)
      .where(
        and(
          eq(schema.rateLimitEvents.ip, ip),
          lt(schema.rateLimitEvents.createdAt, new Date(purgeBefore)),
        ),
      )
      .run();

    const rows = tx
      .select({ createdAt: schema.rateLimitEvents.createdAt })
      .from(schema.rateLimitEvents)
      .where(
        and(
          eq(schema.rateLimitEvents.ip, ip),
          eq(schema.rateLimitEvents.kind, kind),
          gte(schema.rateLimitEvents.createdAt, new Date(windowStart)),
        ),
      )
      .all();

    if (rows.length >= max) {
      const oldest = rows.reduce(
        (min, r) => Math.min(min, r.createdAt.getTime()),
        Number.POSITIVE_INFINITY,
      );
      return {
        ok: false,
        remaining: 0,
        retryAfterMs: Math.max(0, oldest + windowMs - now),
        windowMs,
        max,
      };
    }

    tx.insert(schema.rateLimitEvents)
      .values({ ip, kind, createdAt: new Date(now) })
      .run();

    return {
      ok: true,
      remaining: max - rows.length - 1,
      retryAfterMs: 0,
      windowMs,
      max,
    };
  });
}

/** Read-only count, no insert. Useful for tests and admin views. */
export function countRateLimit(ip: string, kind: RateLimitKind, now = Date.now()): number {
  const { windowMs } = configFor(kind);
  const windowStart = now - windowMs;
  const rows = db
    .select({ id: schema.rateLimitEvents.id })
    .from(schema.rateLimitEvents)
    .where(
      and(
        eq(schema.rateLimitEvents.ip, ip),
        eq(schema.rateLimitEvents.kind, kind),
        gte(schema.rateLimitEvents.createdAt, new Date(windowStart)),
      ),
    )
    .all();
  return rows.length;
}

// Silence eslint when sql is imported but unused locally.
void sql;
