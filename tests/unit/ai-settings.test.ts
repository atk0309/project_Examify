import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `ai-settings-${process.pid}.db`);
const CLIENT_IP = '203.0.113.77';
Reflect.set(process.env, 'DATABASE_URL', `file:${DB_PATH}`);
delete process.env.FAMILIES;

const sessionHolder = vi.hoisted(() => ({ current: {} as SessionData }));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, getSession: async () => sessionHolder.current };
});

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.77' }),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const AI_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'EXAMIFY_AI_MODE',
  'EXAMIFY_ANTHROPIC_MODEL',
  'EXAMIFY_OPENAI_MODEL',
  'EXAMIFY_LLM_BASE_URL',
  'EXAMIFY_LLM_MODEL',
  'EXAMIFY_CLAUDE_MODEL',
  'EXAMIFY_CODEX_MODEL',
  'EXAMIFY_INGEST_LOCAL_CMD',
] as const;
const previousEnv = new Map<string, string | undefined>();
let root: string;

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
  fs.rmSync(DB_PATH, { force: true });
  const sqlite = new Database(DB_PATH);
  migrate(drizzle(sqlite), {
    migrationsFolder: path.join(process.cwd(), 'src', 'lib', 'db', 'migrations'),
  });
  sqlite.close();
});

afterAll(() => {
  fs.rmSync(DB_PATH, { force: true });
});

beforeEach(async () => {
  for (const key of AI_ENV_KEYS) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  const { db, schema } = await import('@/lib/db');
  const { resetLegacyImportLatch } = await import('@/lib/households');
  db.delete(schema.rateLimitEvents).run();
  db.delete(schema.householdMembers).run();
  db.delete(schema.households).run();
  db.delete(schema.users).run();
  resetLegacyImportLatch();
  sessionHolder.current = {};
  root = fs.mkdtempSync(path.join(tmpdir(), 'examify-ai-settings-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  const { setEnvStoreRootForTests, setInitialEnvironForTests } = await import('@/lib/env-store');
  setEnvStoreRootForTests(root);
  setInitialEnvironForTests({});
  // These settings actions must never probe a paid provider to determine readiness.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('unexpected provider request'))),
  );
});

afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  const { setEnvStoreRootForTests, setInitialEnvironForTests } = await import('@/lib/env-store');
  setEnvStoreRootForTests(null);
  setInitialEnvironForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
  for (const key of AI_ENV_KEYS) {
    const previous = previousEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  previousEnv.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function signInAdmin(complete = true) {
  const { bootstrapHousehold } = await import('@/lib/households');
  const host = bootstrapHousehold({ email: 'admin@example.com', householdName: 'Our family' });
  if (!host.ok) throw new Error('failed to bootstrap fixture');
  sessionHolder.current = {
    userId: host.userId,
    email: host.email,
    role: 'parent',
    studentMode: false,
    sessionVersion: host.sessionVersion,
  };
  if (complete) {
    const { completeOnboarding } = await import('@/lib/onboarding');
    completeOnboarding(host.householdId);
  }
  return host;
}

async function expectAllActionsForbidden() {
  const { refreshAiSettingsAction, saveAiModeAction, setAiConfigAction, setAiKeyAction } =
    await import('@/actions/ai-settings');
  const forbidden = { ok: false, reason: 'forbidden' };
  expect(await refreshAiSettingsAction()).toEqual(forbidden);
  expect(await saveAiModeAction(form({ aiMode: 'skip-stub' }))).toEqual(forbidden);
  for (const provider of ['anthropic', 'openai']) {
    expect(
      await setAiKeyAction(form({ provider, intent: 'set', apiKey: 'sk-unauthorized-secret' })),
    ).toEqual(forbidden);
    expect(await setAiKeyAction(form({ provider, intent: 'clear' }))).toEqual(forbidden);
  }
  for (const intent of ['set', 'clear']) {
    expect(
      await setAiConfigAction(form({ key: 'EXAMIFY_OPENAI_MODEL', value: 'model-a', intent })),
    ).toEqual(forbidden);
  }
  expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  const { countRateLimit } = await import('@/lib/rate-limit');
  expect(countRateLimit(CLIENT_IP, 'env_write')).toBe(0);
}

describe('AI settings admin authorization', () => {
  it('refuses every read and mutation for a signed-out session', async () => {
    const { requireAiSettingsAdmin } = await import('@/lib/ai-settings');
    expect(await requireAiSettingsAdmin()).toEqual({ ok: false, reason: 'forbidden' });
    await expectAllActionsForbidden();
  });

  it.each(['student', 'parent'] as const)(
    'refuses every action for an invited %s even after onboarding is complete',
    async (role) => {
      const host = await signInAdmin();
      const { db, schema } = await import('@/lib/db');
      const member = db
        .insert(schema.users)
        .values({ email: `${role}@example.com`, emailVerifiedAt: new Date() })
        .returning()
        .get()!;
      db.insert(schema.householdMembers)
        .values({ householdId: host.householdId, userId: member.id, role })
        .run();
      sessionHolder.current = { userId: member.id, email: member.email, role };
      const { requireAiSettingsAdmin } = await import('@/lib/ai-settings');
      expect(await requireAiSettingsAdmin()).toEqual({ ok: false, reason: 'forbidden' });
      await expectAllActionsForbidden();
    },
  );

  it('refuses a student-role session even when its user is the household admin', async () => {
    await signInAdmin();
    sessionHolder.current.role = 'student';
    await expectAllActionsForbidden();
  });

  it.each(['demoted', 'removed'] as const)(
    're-checks live membership when a previously authorized admin has been %s',
    async (change) => {
      const host = await signInAdmin();
      const { requireAiSettingsAdmin } = await import('@/lib/ai-settings');
      expect(await requireAiSettingsAdmin()).toEqual({ ok: true, householdId: host.householdId });
      const { db, schema } = await import('@/lib/db');
      if (change === 'demoted') {
        db.update(schema.householdMembers)
          .set({ role: 'parent' })
          .where(eq(schema.householdMembers.userId, host.userId))
          .run();
      } else {
        db.delete(schema.householdMembers)
          .where(eq(schema.householdMembers.userId, host.userId))
          .run();
      }
      expect(await requireAiSettingsAdmin()).toEqual({ ok: false, reason: 'forbidden' });
      await expectAllActionsForbidden();
    },
  );

  it.each([false, true])('allows the admin when onboarding completion is %s', async (complete) => {
    const host = await signInAdmin(complete);
    const { requireAiSettingsAdmin } = await import('@/lib/ai-settings');
    const { refreshAiSettingsAction, saveAiModeAction } = await import('@/actions/ai-settings');
    expect(await requireAiSettingsAdmin()).toEqual({ ok: true, householdId: host.householdId });
    expect((await refreshAiSettingsAction()).ok).toBe(true);
    const saved = await saveAiModeAction(form({ aiMode: 'skip-stub' }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error('expected saved mode');
    expect(saved.snapshot.aiMode).toBe('skip-stub');
    const { getHouseholdOnboarding } = await import('@/lib/onboarding');
    expect(getHouseholdOnboarding(host.householdId).state.aiMode).toBe('skip-stub');
    expect(getHouseholdOnboarding(host.householdId).complete).toBe(complete);
  });

  it('changes only the live admin household and preserves its content-onboarding state', async () => {
    const host = await signInAdmin();
    const { db, schema } = await import('@/lib/db');
    const other = db
      .insert(schema.households)
      .values({
        name: 'Another family',
        onboardingComplete: true,
        onboardingState: { aiMode: 'cloud' },
      })
      .returning()
      .get()!;
    const { getHouseholdOnboarding, saveOnboardingState } = await import('@/lib/onboarding');
    saveOnboardingState(host.householdId, {
      applied: true,
      dryRunHash: 'confirmed-content-hash',
      replaceSample: true,
    });
    const { saveAiModeAction } = await import('@/actions/ai-settings');
    const result = await saveAiModeAction(
      form({ aiMode: 'skip-stub', householdId: String(other.id) }),
    );
    expect(result.ok).toBe(true);
    expect(getHouseholdOnboarding(host.householdId)).toMatchObject({
      complete: true,
      state: {
        aiMode: 'skip-stub',
        applied: true,
        dryRunHash: 'confirmed-content-hash',
        replaceSample: true,
      },
    });
    expect(getHouseholdOnboarding(other.id).state.aiMode).toBe('cloud');
  });
});

describe('AI settings input validation', () => {
  it.each(['', 'anthropic', 'shell', 'cloud\nEXAMIFY_INGEST_LOCAL_CMD=malicious'])(
    'refuses an invalid mode without changing household state: %j',
    async (aiMode) => {
      const host = await signInAdmin();
      const { saveAiModeAction } = await import('@/actions/ai-settings');
      expect(await saveAiModeAction(form({ aiMode }))).toEqual({ ok: false, reason: 'invalid' });
      const { getHouseholdOnboarding } = await import('@/lib/onboarding');
      expect(getHouseholdOnboarding(host.householdId).state.aiMode).toBeUndefined();
      expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
    },
  );

  it.each(['', 'ANTHROPIC_API_KEY', 'local', 'openai\nOTHER=secret'])(
    'refuses an unknown key provider: %j',
    async (provider) => {
      await signInAdmin();
      const { setAiKeyAction } = await import('@/actions/ai-settings');
      expect(
        await setAiKeyAction(form({ provider, intent: 'set', apiKey: 'sk-do-not-write' })),
      ).toEqual({ ok: false, reason: 'invalid' });
      expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
    },
  );

  it.each([
    'EXAMIFY_INGEST_LOCAL_CMD',
    'EXAMIFY_CLAUDE_BIN',
    'EXAMIFY_CODEX_BIN',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'AUTH_SECRET',
    'NEXT_PUBLIC_API_KEY',
    '__proto__',
  ])('refuses non-allowlisted config key %s for both set and clear', async (key) => {
    await signInAdmin();
    const { setAiConfigAction } = await import('@/actions/ai-settings');
    for (const intent of ['set', 'clear']) {
      expect(await setAiConfigAction(form({ key, intent, value: 'should-not-write' }))).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });

  it('rejects missing, non-string, and unsupported mutation intents', async () => {
    await signInAdmin();
    const { saveAiModeAction, setAiConfigAction, setAiKeyAction } =
      await import('@/actions/ai-settings');
    const invalid = { ok: false, reason: 'invalid' };
    expect(await saveAiModeAction(new FormData())).toEqual(invalid);
    const fileMode = new FormData();
    fileMode.set('aiMode', new File(['skip-stub'], 'mode.txt'));
    expect(await saveAiModeAction(fileMode)).toEqual(invalid);
    expect(await setAiKeyAction(form({ provider: 'openai', apiKey: 'sk-missing-intent' }))).toEqual(
      invalid,
    );
    expect(await setAiKeyAction(form({ provider: 'openai', intent: 'delete' }))).toEqual(invalid);
    expect(
      await setAiConfigAction(form({ key: 'EXAMIFY_OPENAI_MODEL', value: 'model-a' })),
    ).toEqual(invalid);
    expect(
      await setAiConfigAction(form({ key: 'EXAMIFY_OPENAI_MODEL', intent: 'delete' })),
    ).toEqual(invalid);
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });

  it.each([
    'ftp://localhost:11434',
    'http://user:password@localhost:11434',
    'http://localhost:11434?api_key=secret',
    'http://localhost:11434/#secret',
    'http://localhost:11434\nOPENAI_API_KEY=injected',
    '${EXFILTRATE_URL}',
    'http://localhost:11434/`command`',
    'not-a-url',
  ])('refuses an unsafe local endpoint without writing it: %j', async (value) => {
    await signInAdmin();
    const { setAiConfigAction } = await import('@/actions/ai-settings');
    expect(
      await setAiConfigAction(form({ key: 'EXAMIFY_LLM_BASE_URL', value, intent: 'set' })),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });

  it.each([
    '',
    'model name',
    'model\nOTHER=value',
    'model\0secret',
    '${TOKEN}',
    'm;command',
    'x'.repeat(257),
  ])('refuses an unsafe model value without writing it: %j', async (value) => {
    await signInAdmin();
    const { setAiConfigAction } = await import('@/actions/ai-settings');
    expect(
      await setAiConfigAction(form({ key: 'EXAMIFY_OPENAI_MODEL', value, intent: 'set' })),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });

  it.each([
    '',
    'test',
    'sk-key\nOTHER=injected',
    'sk-key\rOTHER=injected',
    'sk-key\0secret',
    'x'.repeat(257),
  ])('refuses an invalid credential without returning it: %j', async (apiKey) => {
    await signInAdmin();
    const { setAiKeyAction } = await import('@/actions/ai-settings');
    expect(await setAiKeyAction(form({ provider: 'openai', intent: 'set', apiKey }))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });
});

describe('AI credentials after onboarding', () => {
  it.each([
    ['anthropic', 'ANTHROPIC_API_KEY', 'cloud'],
    ['openai', 'OPENAI_API_KEY', 'cloud-openai'],
  ] as const)(
    'sets, rotates, and clears %s without returning any credential',
    async (provider, key, mode) => {
      const host = await signInAdmin();
      const { saveAiModeAction, setAiKeyAction } = await import('@/actions/ai-settings');
      expect((await saveAiModeAction(form({ aiMode: mode }))).ok).toBe(true);
      const original = `sk-${provider}-private-original`;
      const rotated = `sk-${provider}-private-rotated`;
      const originalFile = `SITE_URL=http://localhost:3000\n${key}=${original}\n`;
      fs.writeFileSync(path.join(root, '.env'), originalFile);
      fs.writeFileSync(path.join(root, '.env.local'), `${key}=${original}\nKEEP=1\n`);
      process.env[key] = original;
      for (const apiKey of [original, rotated]) {
        const saved = await setAiKeyAction(form({ provider, intent: 'set', apiKey }));
        expect(saved.ok).toBe(true);
        if (!saved.ok) throw new Error('expected saved credential');
        expect(saved.snapshot[`${provider}Configured`]).toBe(true);
        expect(saved.snapshot[`${provider}WriteBlocked`]).toBe(false);
        expect(saved.snapshot.aiMode).toBe(mode);
        expect(JSON.stringify(saved)).not.toContain(original);
        expect(JSON.stringify(saved)).not.toContain(rotated);
        expect(process.env[key]).toBe(apiKey);
        expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toContain(`${key}=${apiKey}`);
        expect(fs.readFileSync(path.join(root, '.env.local'), 'utf8')).toContain(
          `${key}=${apiKey}`,
        );
        expect(fs.statSync(path.join(root, '.env')).mode & 0o777).toBe(0o600);
      }
      const cleared = await setAiKeyAction(form({ provider, intent: 'clear' }));
      expect(cleared.ok).toBe(true);
      if (!cleared.ok) throw new Error('expected cleared credential');
      expect(cleared.snapshot[`${provider}Configured`]).toBe(false);
      expect(cleared.snapshot[`${provider}Present`]).toBe(false);
      expect(cleared.snapshot.aiMode).toBe(mode);
      expect(JSON.stringify(cleared)).not.toContain(rotated);
      expect(process.env[key]).toBeUndefined();
      expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe(
        'SITE_URL=http://localhost:3000\n',
      );
      expect(fs.readFileSync(path.join(root, '.env.local'), 'utf8')).toBe('KEEP=1\n');
      const { getHouseholdOnboarding, markingStatusForUser } = await import('@/lib/onboarding');
      expect(getHouseholdOnboarding(host.householdId).complete).toBe(true);
      expect((await markingStatusForUser(host.userId)).readiness).toBe('not_ready');
    },
  );

  it.each(['anthropic', 'openai'])(
    'allows clearing an already missing %s key',
    async (provider) => {
      await signInAdmin();
      const { setAiKeyAction } = await import('@/actions/ai-settings');
      const cleared = await setAiKeyAction(form({ provider, intent: 'clear' }));
      expect(cleared.ok).toBe(true);
      expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
    },
  );

  it.each(['anthropic', 'openai'] as const)(
    'preserves host-managed %s credentials on set and clear',
    async (provider) => {
      await signInAdmin();
      const key = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
      const original = `sk-${provider}-host-owned-secret`;
      const attempted = `sk-${provider}-attempted-replacement`;
      fs.writeFileSync(path.join(root, '.env'), `${key}=${original}\n`);
      process.env[key] = original;
      const { setInitialEnvironForTests } = await import('@/lib/env-store');
      setInitialEnvironForTests({ [key]: original });
      const { refreshAiSettingsAction, setAiKeyAction } = await import('@/actions/ai-settings');
      const snapshot = await refreshAiSettingsAction();
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) throw new Error('expected settings snapshot');
      expect(snapshot.snapshot[`${provider}WriteBlocked`]).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain(original);
      expect(await setAiKeyAction(form({ provider, intent: 'set', apiKey: attempted }))).toEqual({
        ok: false,
        reason: 'host_managed',
      });
      expect(await setAiKeyAction(form({ provider, intent: 'clear' }))).toEqual({
        ok: false,
        reason: 'host_managed',
      });
      expect(process.env[key]).toBe(original);
      expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe(`${key}=${original}\n`);
    },
  );

  it('refuses replacing a host-injected empty credential', async () => {
    await signInAdmin();
    process.env.OPENAI_API_KEY = '';
    const { setInitialEnvironForTests } = await import('@/lib/env-store');
    setInitialEnvironForTests({ OPENAI_API_KEY: '' });
    const { setAiKeyAction } = await import('@/actions/ai-settings');
    expect(
      await setAiKeyAction(form({ provider: 'openai', intent: 'set', apiKey: 'sk-new' })),
    ).toEqual({
      ok: false,
      reason: 'host_managed',
    });
    expect(process.env.OPENAI_API_KEY).toBe('');
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });

  it('allows saving, rotating, and clearing after a host test sentinel', async () => {
    await signInAdmin();
    process.env.ANTHROPIC_API_KEY = 'test';
    const { setInitialEnvironForTests } = await import('@/lib/env-store');
    setInitialEnvironForTests({ ANTHROPIC_API_KEY: 'test' });
    const { setAiKeyAction } = await import('@/actions/ai-settings');
    for (const apiKey of ['sk-new-private-key', 'sk-rotated-private-key']) {
      const result = await setAiKeyAction(form({ provider: 'anthropic', intent: 'set', apiKey }));
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain(apiKey);
    }
    expect((await setAiKeyAction(form({ provider: 'anthropic', intent: 'clear' }))).ok).toBe(true);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it.each(['set', 'clear'])(
    'returns only a disk reason when credential %s cannot write .env',
    async (intent) => {
      await signInAdmin();
      fs.mkdirSync(path.join(root, '.env'));
      const { setAiKeyAction } = await import('@/actions/ai-settings');
      const result = await setAiKeyAction(
        form({ provider: 'openai', intent, apiKey: 'sk-secret-disk-failure' }),
      );
      expect(result).toEqual({ ok: false, reason: 'disk' });
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
    },
  );
});

describe('AI model and endpoint configuration', () => {
  it('allows a model named test while continuing to reject test as an API credential', async () => {
    await signInAdmin();
    const { setAiConfigAction, setAiKeyAction } = await import('@/actions/ai-settings');
    const saved = await setAiConfigAction(
      form({ key: 'EXAMIFY_LLM_MODEL', value: 'test', intent: 'set' }),
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error('expected saved test model');
    expect(saved.snapshot.config.EXAMIFY_LLM_MODEL).toEqual({
      configured: true,
      writeBlocked: false,
    });
    expect(process.env.EXAMIFY_LLM_MODEL).toBe('test');
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('EXAMIFY_LLM_MODEL=test\n');
    for (const provider of ['anthropic', 'openai']) {
      expect(await setAiKeyAction(form({ provider, apiKey: 'test', intent: 'set' }))).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
    const cleared = await setAiConfigAction(form({ key: 'EXAMIFY_LLM_MODEL', intent: 'clear' }));
    expect(cleared.ok).toBe(true);
    expect(process.env.EXAMIFY_LLM_MODEL).toBeUndefined();
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('');
  });

  it('keeps a host-injected model named test locked on both set and clear', async () => {
    await signInAdmin();
    process.env.EXAMIFY_LLM_MODEL = 'test';
    fs.writeFileSync(path.join(root, '.env'), 'EXAMIFY_LLM_MODEL=test\n');
    const { setInitialEnvironForTests } = await import('@/lib/env-store');
    setInitialEnvironForTests({ EXAMIFY_LLM_MODEL: 'test' });
    const { refreshAiSettingsAction, setAiConfigAction } = await import('@/actions/ai-settings');
    const current = await refreshAiSettingsAction();
    expect(current.ok).toBe(true);
    if (!current.ok) throw new Error('expected host-managed snapshot');
    expect(current.snapshot.config.EXAMIFY_LLM_MODEL).toEqual({
      configured: true,
      writeBlocked: true,
    });
    for (const intent of ['set', 'clear']) {
      expect(
        await setAiConfigAction(form({ key: 'EXAMIFY_LLM_MODEL', value: 'replacement', intent })),
      ).toEqual({ ok: false, reason: 'host_managed' });
    }
    expect(process.env.EXAMIFY_LLM_MODEL).toBe('test');
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('EXAMIFY_LLM_MODEL=test\n');
  });

  it.each([
    ['EXAMIFY_ANTHROPIC_MODEL', 'claude-fixture-20260101'],
    ['EXAMIFY_OPENAI_MODEL', 'gpt-fixture'],
    ['EXAMIFY_LLM_BASE_URL', 'http://127.0.0.1:11434/v1'],
    ['EXAMIFY_LLM_MODEL', 'example/model:latest'],
    ['EXAMIFY_CLAUDE_MODEL', 'sonnet'],
    ['EXAMIFY_CODEX_MODEL', 'gpt-codex-fixture'],
  ] as const)(
    'persists and clears allowlisted %s without exposing its stored value',
    async (key, value) => {
      await signInAdmin();
      const { setAiConfigAction } = await import('@/actions/ai-settings');
      const saved = await setAiConfigAction(form({ key, value, intent: 'set' }));
      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error('expected saved config');
      expect(saved.snapshot.config[key]).toEqual({ configured: true, writeBlocked: false });
      expect(JSON.stringify(saved)).not.toContain(value);
      expect(process.env[key]).toBe(value);
      expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toContain(`${key}=${value}`);
      const cleared = await setAiConfigAction(form({ key, intent: 'clear' }));
      expect(cleared.ok).toBe(true);
      if (!cleared.ok) throw new Error('expected cleared config');
      expect(cleared.snapshot.config[key]).toEqual({ configured: false, writeBlocked: false });
      expect(process.env[key]).toBeUndefined();
      expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).not.toContain(`${key}=`);
    },
  );

  it('refuses changing a host-managed model, including when its value matches the file', async () => {
    await signInAdmin();
    process.env.EXAMIFY_OPENAI_MODEL = 'private-host-model';
    fs.writeFileSync(path.join(root, '.env'), 'EXAMIFY_OPENAI_MODEL=private-host-model\n');
    const { setInitialEnvironForTests } = await import('@/lib/env-store');
    setInitialEnvironForTests({ EXAMIFY_OPENAI_MODEL: 'private-host-model' });
    const { setAiConfigAction } = await import('@/actions/ai-settings');
    for (const intent of ['set', 'clear']) {
      expect(
        await setAiConfigAction(form({ key: 'EXAMIFY_OPENAI_MODEL', value: 'new-model', intent })),
      ).toEqual({
        ok: false,
        reason: 'host_managed',
      });
    }
    expect(process.env.EXAMIFY_OPENAI_MODEL).toBe('private-host-model');
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe(
      'EXAMIFY_OPENAI_MODEL=private-host-model\n',
    );
  });

  it('returns no credentials, sensitive URLs, local command, paths, or content in the snapshot', async () => {
    const host = await signInAdmin();
    const sensitiveValues = {
      ANTHROPIC_API_KEY: 'sk-anthropic-private-snapshot',
      OPENAI_API_KEY: 'sk-openai-private-snapshot',
      EXAMIFY_LLM_BASE_URL:
        'https://private-user:private-password@private-host.example/v1?token=private-token',
      EXAMIFY_LLM_MODEL: 'private-model-name',
      EXAMIFY_INGEST_LOCAL_CMD: '/private/bin/runner --token=private-command-token',
    };
    Object.assign(process.env, sensitiveValues);
    const { getAiSettingsSnapshot } = await import('@/lib/ai-settings');
    const snapshot = await getAiSettingsSnapshot(host.householdId);
    const serialized = JSON.stringify(snapshot);
    for (const value of Object.values(sensitiveValues)) expect(serialized).not.toContain(value);
    for (const fragment of ['private-password', 'private-token', 'private-command-token', root]) {
      expect(serialized).not.toContain(fragment);
    }
    for (const property of [
      'subjects',
      'sampleSubjects',
      'builtinSubjects',
      'dataDirDisplay',
      'liveSubjects',
      'hasDryRun',
      'hasApplied',
    ]) {
      expect(snapshot).not.toHaveProperty(property);
    }
    expect(snapshot.anthropicConfigured).toBe(true);
    expect(snapshot.openaiConfigured).toBe(true);
    expect(snapshot.config.EXAMIFY_LLM_BASE_URL).toEqual({ configured: true, writeBlocked: true });
  });

  it.each(['set', 'clear'])(
    'returns only a disk reason when config %s cannot write .env',
    async (intent) => {
      await signInAdmin();
      fs.mkdirSync(path.join(root, '.env'));
      const { setAiConfigAction } = await import('@/actions/ai-settings');
      expect(
        await setAiConfigAction(form({ key: 'EXAMIFY_OPENAI_MODEL', value: 'model-a', intent })),
      ).toEqual({
        ok: false,
        reason: 'disk',
      });
      expect(process.env.EXAMIFY_OPENAI_MODEL).toBeUndefined();
    },
  );
});

describe('AI settings rate limiting and cache invalidation', () => {
  it.each(['set', 'clear'])(
    'maps credential provenance read failures to disk when attempting %s',
    async (intent) => {
      await signInAdmin();
      process.env.OPENAI_API_KEY = 'sk-existing-private-credential';
      fs.mkdirSync(path.join(root, '.env'));
      const { setAiKeyAction } = await import('@/actions/ai-settings');
      expect(
        await setAiKeyAction(form({ provider: 'openai', intent, apiKey: 'sk-new-private-key' })),
      ).toEqual({ ok: false, reason: 'disk' });
      expect(process.env.OPENAI_API_KEY).toBe('sk-existing-private-credential');
    },
  );

  it('returns only a disk reason when refresh cannot read the settings store', async () => {
    await signInAdmin();
    fs.mkdirSync(path.join(root, '.env'));
    const { refreshAiSettingsAction } = await import('@/actions/ai-settings');
    expect(await refreshAiSettingsAction()).toEqual({ ok: false, reason: 'disk' });
  });

  it('shares the env_write limit across all mutations and refresh, isolated from signin', async () => {
    const host = await signInAdmin();
    const { refreshAiSettingsAction, saveAiModeAction, setAiConfigAction, setAiKeyAction } =
      await import('@/actions/ai-settings');
    const { countRateLimit, checkRateLimit } = await import('@/lib/rate-limit');
    const { env } = await import('@/lib/env');
    for (let i = 0; i < env.RATE_LIMIT_SIGNIN_MAX; i += 1) {
      checkRateLimit(CLIENT_IP, 'signin');
    }
    const requests = [
      () => saveAiModeAction(form({ aiMode: 'skip-stub' })),
      () => setAiKeyAction(form({ provider: 'openai', intent: 'set', apiKey: 'sk-rate-private' })),
      () =>
        setAiConfigAction(form({ key: 'EXAMIFY_OPENAI_MODEL', value: 'model-a', intent: 'set' })),
      () => refreshAiSettingsAction(),
    ];
    for (let i = 0; i < env.RATE_LIMIT_SIGNIN_MAX; i += 1) {
      const request = requests[i % requests.length]!;
      expect((await request()).ok).toBe(true);
    }
    expect(countRateLimit(CLIENT_IP, 'env_write')).toBe(env.RATE_LIMIT_SIGNIN_MAX);
    const before = fs.readFileSync(path.join(root, '.env'), 'utf8');
    for (const request of requests) {
      expect(await request()).toEqual({ ok: false, reason: 'rate_limited' });
    }
    expect(await setAiKeyAction(form({ provider: 'openai', intent: 'clear' }))).toEqual({
      ok: false,
      reason: 'rate_limited',
    });
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe(before);
    const { getHouseholdOnboarding } = await import('@/lib/onboarding');
    expect(getHouseholdOnboarding(host.householdId).state.aiMode).toBe('skip-stub');
    expect(process.env.OPENAI_API_KEY).toBe('sk-rate-private');
  });

  it('invalidates the dashboard and settings after a successful mutation', async () => {
    await signInAdmin();
    const { saveAiModeAction } = await import('@/actions/ai-settings');
    const { revalidatePath } = await import('next/cache');
    expect((await saveAiModeAction(form({ aiMode: 'skip-stub' }))).ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith('/');
    expect(revalidatePath).toHaveBeenCalledWith('/settings/ai');
  });
});
