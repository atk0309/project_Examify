import 'server-only';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db, schema } from './db';
import { env } from './env';

export type RateLimitKind = 'signin' | 'invite' | 'env_write';

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

/** Rows older than this are deleted by the global purge. */
export const RATE_LIMIT_RETENTION_MS = 7 * 24 * 3_600_000;
/**
 * The global purge scans the whole table (the only index leads with `ip`), so
 * `checkRateLimit` runs it at most this often per process, not per request.
 */
export const RATE_LIMIT_PURGE_INTERVAL_MS = 3_600_000;

let nextGlobalPurgeAt = 0;

/**
 * Delete **every** row older than the retention window — not only one IP's —
 * so buckets that are never checked again (a one-off address, the per-account
 * `pw:` / `otp:` / `reset:` buckets) cannot grow the table without bound.
 */
export function purgeStaleRateLimitEvents(now = Date.now()): void {
  db.delete(schema.rateLimitEvents)
    .where(lt(schema.rateLimitEvents.createdAt, new Date(now - RATE_LIMIT_RETENTION_MS)))
    .run();
}

/**
 * Sliding-window rate limit. Counts events in `[now - windowMs, now]` for the
 * given (ip, kind). If under the cap, inserts a new event and returns ok=true.
 * Runs {@link purgeStaleRateLimitEvents} at most once per
 * {@link RATE_LIMIT_PURGE_INTERVAL_MS}.
 */
export function checkRateLimit(ip: string, kind: RateLimitKind, now = Date.now()): RateLimitResult {
  const { max, windowMs } = configFor(kind);
  const windowStart = now - windowMs;

  if (now >= nextGlobalPurgeAt) {
    purgeStaleRateLimitEvents(now);
    nextGlobalPurgeAt = now + RATE_LIMIT_PURGE_INTERVAL_MS;
  }

  return db.transaction((tx) => {
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
