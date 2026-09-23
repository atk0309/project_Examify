import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnsafeDataDirError } from '@/lib/data-dir';

const dbState = vi.hoisted(() => ({ fail: null as null | (() => Error) }));

// Keep the real module (DatabaseMissingError, openSqliteFile) and replace
// only the lazy `db` proxy, so each case controls what the query throws.
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  const chain = { from: () => chain, limit: () => chain, all: () => [] };
  return {
    ...actual,
    db: {
      select: () => {
        if (dbState.fail) throw dbState.fail();
        return chain;
      },
    },
  };
});

const temps: string[] = [];

afterEach(() => {
  dbState.fail = null;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function health(): Promise<{ status: number; body: Record<string, unknown> }> {
  const { GET } = await import('@/app/api/health/route');
  const res = await GET();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/health', () => {
  it('answers ok with uptime when the database responds', async () => {
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe('number');
  });

  it('answers a reason code, never the error message', async () => {
    const { DatabaseMissingError } = await import('@/lib/db');
    const secretPath = '/srv/family/examify-data/app.db';
    const cases: Array<[() => Error, string]> = [
      [
        () => new UnsafeDataDirError('inside_checkout', 'data folder inside the checkout'),
        'unsafe_data_dir',
      ],
      [() => new DatabaseMissingError(), 'db_missing'],
      [() => new Error(`SQLITE_CANTOPEN: unable to open ${secretPath}`), 'db_error'],
      [() => new Error('no such table: users'), 'db_error'],
    ];
    for (const [fail, reason] of cases) {
      dbState.fail = fail;
      const { status, body } = await health();
      expect(status).toBe(503);
      expect(body).toEqual({ ok: false, reason });
      expect(JSON.stringify(body)).not.toContain(secretPath);
    }
  });
});

describe('openSqliteFile', () => {
  function tempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'examify-db-open-'));
    temps.push(dir);
    return dir;
  }

  it('fails closed in production when the database file is missing, creating nothing', async () => {
    const { DatabaseMissingError, openSqliteFile } = await import('@/lib/db');
    const unmounted = path.join(tempDir(), 'volume', 'app.db');
    let thrown: unknown;
    try {
      openSqliteFile(unmounted, { mustExist: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DatabaseMissingError);
    expect((thrown as Error).message).toContain('pnpm db:migrate');
    expect((thrown as Error).message).not.toContain(unmounted);
    expect(existsSync(path.dirname(unmounted))).toBe(false);
  });

  it('opens an existing database when it must exist', async () => {
    const { openSqliteFile } = await import('@/lib/db');
    const file = path.join(tempDir(), 'app.db');
    openSqliteFile(file, { mustExist: false }).close();
    const sqlite = openSqliteFile(file, { mustExist: true });
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    sqlite.close();
  });

  it('creates the folder and file outside production', async () => {
    const { openSqliteFile } = await import('@/lib/db');
    const file = path.join(tempDir(), 'nested', 'app.db');
    openSqliteFile(file, { mustExist: false }).close();
    expect(existsSync(file)).toBe(true);
  });
});
