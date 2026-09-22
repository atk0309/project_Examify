import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `rate-limit-${process.pid}.db`);

// Deterministic, low cap for the "allows up to max then blocks" assertion.
// Set before any import of '@/lib/env' so the parsed value picks it up.
Reflect.set(process.env, 'RATE_LIMIT_SIGNIN_MAX', '3');

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  Reflect.set(process.env, 'DATABASE_URL', `file:${DB_PATH}`);
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  const tmpDb = drizzle(sqlite);
  migrate(tmpDb, {
    migrationsFolder: path.join(process.cwd(), 'src', 'lib', 'db', 'migrations'),
  });
  sqlite.close();
});

afterAll(() => {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
});

beforeEach(async () => {
  const { db, schema } = await import('@/lib/db');
  db.delete(schema.rateLimitEvents).run();
});

describe('checkRateLimit', () => {
  it('allows up to the configured max, then blocks', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit');
    const ip = '203.0.113.1';
    const now = 1_000_000_000_000;
    const r1 = checkRateLimit(ip, 'signin', now);
    const r2 = checkRateLimit(ip, 'signin', now + 1);
    const r3 = checkRateLimit(ip, 'signin', now + 2);
    const r4 = checkRateLimit(ip, 'signin', now + 3);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(r4.ok).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.retryAfterMs).toBeGreaterThan(0);
  });

  it('expires old events outside the sliding window', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit');
    const { env } = await import('@/lib/env');
    const ip = '203.0.113.3';
    const t0 = 1_000_000_000_000;
    checkRateLimit(ip, 'signin', t0);
    checkRateLimit(ip, 'signin', t0 + 1);
    checkRateLimit(ip, 'signin', t0 + 2);
    expect(checkRateLimit(ip, 'signin', t0 + 3).ok).toBe(false);
    // Step past the window so all events fall out.
    const future = t0 + env.RATE_LIMIT_SIGNIN_WINDOW_MS + 10;
    expect(checkRateLimit(ip, 'signin', future).ok).toBe(true);
  });

  it('counts per-ip, so a different ip is unaffected', async () => {
    const { checkRateLimit, countRateLimit } = await import('@/lib/rate-limit');
    const now = 1_000_000_000_000;
    checkRateLimit('203.0.113.10', 'signin', now);
    checkRateLimit('203.0.113.10', 'signin', now + 1);
    checkRateLimit('203.0.113.10', 'signin', now + 2);
    expect(checkRateLimit('203.0.113.11', 'signin', now + 3).ok).toBe(true);
    expect(countRateLimit('203.0.113.10', 'signin', now + 3)).toBe(3);
  });

  it('purges every row older than the retention window, not only the caller ip', async () => {
    const { checkRateLimit, RATE_LIMIT_RETENTION_MS } = await import('@/lib/rate-limit');
    const { db, schema } = await import('@/lib/db');
    const now = 1_000_000_000_000;
    const stale = new Date(now - RATE_LIMIT_RETENTION_MS - 1);
    const fresh = new Date(now - RATE_LIMIT_RETENTION_MS + 60_000);
    // Buckets nobody checks again: one-off spoofed addresses and the
    // per-account / guess buckets that never go through checkRateLimit.
    db.insert(schema.rateLimitEvents)
      .values([
        { ip: '192.0.2.1', kind: 'signin', createdAt: stale },
        { ip: '192.0.2.2', kind: 'invite', createdAt: stale },
        { ip: 'pw:pat@example.com', kind: 'signin', createdAt: stale },
        { ip: 'otp:pat@example.com:parent', kind: 'signin', createdAt: stale },
        { ip: '192.0.2.3', kind: 'signin', createdAt: fresh },
        { ip: 'reset:pat@example.com:parent', kind: 'signin', createdAt: fresh },
      ])
      .run();

    expect(checkRateLimit('203.0.113.99', 'signin', now).ok).toBe(true);

    const left = db
      .select({ ip: schema.rateLimitEvents.ip })
      .from(schema.rateLimitEvents)
      .all()
      .map((r) => r.ip)
      .sort();
    expect(left).toEqual(['192.0.2.3', '203.0.113.99', 'reset:pat@example.com:parent']);
  });
});
