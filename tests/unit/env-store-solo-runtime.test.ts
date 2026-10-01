import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', async () => {
  const schema = await import('@/lib/db/schema');
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: path.join(process.cwd(), 'src/lib/db/migrations') });
  return { db: drizzle(sqlite, { schema }), schema };
});

import { db, schema } from '@/lib/db';
import { env } from '@/lib/env';
import { getAiSettingsSnapshot } from '@/lib/ai-settings';
import { getEnvStoreRoot, setInitialEnvironForTests } from '@/lib/env-store';
import { gradeAnswers } from '@/lib/grading';
import { markingHostEnv } from '@/lib/grading/backends';
import {
  examMarkingForUser,
  getOnboardingAiSnapshot,
  getOnboardingSnapshot,
  markingStatusForUser,
  onboardingHostEnv,
} from '@/lib/onboarding';

let root: string;
let config: string;
let userId: number;
let householdId: number;
const previousMode = env.EXAMIFY_MODE;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'examify-solo-runtime-'));
  config = path.join(root, 'config');
  mkdirSync(config, { mode: 0o700 });
  mkdirSync(path.join(root, 'data'), { mode: 0o700 });
  // Exercise the real root resolver. Do not set an env-store/cwd test override:
  // the server has a checkout cwd and a separate persistent config directory.
  vi.stubEnv('EXAMIFY_MODE', 'solo');
  vi.stubEnv('EXAMIFY_CONFIG_DIR', config);
  vi.stubEnv('EXAMIFY_TEST_ENV_STORE_DIR', undefined);
  vi.stubEnv('EXAMIFY_DATA_DIR', path.join(root, 'data'));
  vi.stubEnv('DATABASE_URL', `file:${path.join(root, 'data', 'app.db')}`);
  for (const key of [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'EXAMIFY_AI_MODE',
    'EXAMIFY_LLM_BASE_URL',
    'EXAMIFY_LLM_MODEL',
  ])
    vi.stubEnv(key, undefined);
  env.EXAMIFY_MODE = 'solo';
  setInitialEnvironForTests({});
  writeFileSync(
    path.join(config, '.env'),
    'EXAMIFY_LLM_BASE_URL=http://127.0.0.1:11434\nEXAMIFY_LLM_MODEL=fixture-base\n',
    { mode: 0o600 },
  );
  writeFileSync(path.join(config, '.env.local'), 'EXAMIFY_LLM_MODEL=fixture-local\n', {
    mode: 0o600,
  });
  db.delete(schema.householdMembers).run();
  db.delete(schema.households).run();
  db.delete(schema.users).run();
  userId = db.insert(schema.users).values({ email: 'learner@solo.invalid' }).returning().get().id;
  householdId = db
    .insert(schema.households)
    .values({
      name: 'Fixture solo learner',
      onboardingState: { aiMode: 'local-agent' },
    })
    .returning()
    .get().id;
  db.insert(schema.householdMembers).values({ userId, householdId, role: 'admin' }).run();
});

afterEach(() => {
  env.EXAMIFY_MODE = previousMode;
  setInitialEnvironForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('real solo process environment reaches runtime provider settings', () => {
  it('renders Home marking and onboarding/AI snapshots from one validated config root', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected_fixture_fetch'));
    expect(getEnvStoreRoot()).toBe(config);
    expect(onboardingHostEnv()).toMatchObject({
      EXAMIFY_LLM_BASE_URL: 'http://127.0.0.1:11434',
      EXAMIFY_LLM_MODEL: 'fixture-local',
    });
    await expect(markingStatusForUser(userId)).resolves.toMatchObject({
      backend: 'local-endpoint',
      readiness: 'ready',
      needsSignIn: false,
    });
    await expect(examMarkingForUser(userId)).resolves.toMatchObject({ written: 'marked' });
    await expect(getOnboardingSnapshot(householdId)).resolves.toMatchObject({
      aiMode: 'local-agent',
      localHttpConfigured: true,
      localModelConfigured: true,
    });
    await expect(getOnboardingAiSnapshot(householdId)).resolves.toMatchObject({
      aiMode: 'local-agent',
      localHttpConfigured: true,
      localModelConfigured: true,
    });
    await expect(getAiSettingsSnapshot(householdId)).resolves.toMatchObject({
      config: { EXAMIFY_LLM_MODEL: { configured: true, writeBlocked: false } },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('grades through the same saved local settings with only a fixture fetch', async () => {
    expect(markingHostEnv().EXAMIFY_LLM_MODEL).toBe('fixture-local');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  score: 1,
                  verdict: 'Fixture feedback.',
                  gotRight: [],
                  toReview: [],
                }),
              },
            },
          ],
        }),
      ),
    );
    const results = await gradeAnswers(
      [
        {
          question: 'Fixture question',
          rubric: 'Fixture rubric',
          maxScore: 1,
          studentAnswer: 'Fixture answer',
        },
      ],
      'local-endpoint',
    );
    expect(results[0]?.status).toBe('graded');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'fixture-local',
    });
  });
});
