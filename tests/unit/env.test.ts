import { afterEach, describe, expect, it } from 'vitest';
import { allowLocalMailOutbox, env, parseEnv } from '@/lib/env';

const prodBase: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  SITE_URL: 'https://examify.example.com',
  DATABASE_URL: 'file:/data/app.db',
  AUTH_SECRET: 'production-auth-secret-must-be-32-chars',
  ANTHROPIC_API_KEY: 'sk-ant-real',
  SETUP_BOOTSTRAP_SECRET: 'production-setup-secret',
};

describe('parseEnv production fail-closed', () => {
  it('requires SETUP_BOOTSTRAP_SECRET (min 16)', () => {
    expect(() => parseEnv({ ...prodBase, SETUP_BOOTSTRAP_SECRET: undefined })).toThrow(
      /Invalid environment variables/,
    );
    expect(() => parseEnv({ ...prodBase, SETUP_BOOTSTRAP_SECRET: 'short-secret' })).toThrow(
      /Invalid environment variables/,
    );
  });

  it('rejects exactly one Turnstile key', () => {
    expect(() =>
      parseEnv({
        ...prodBase,
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      }),
    ).toThrow(/Invalid environment variables/);
    expect(() =>
      parseEnv({
        ...prodBase,
        TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      }),
    ).toThrow(/Invalid environment variables/);
  });

  it('allows both Turnstile keys unset or both set', () => {
    expect(parseEnv(prodBase).SETUP_BOOTSTRAP_SECRET).toBe('production-setup-secret');
    expect(
      parseEnv({
        ...prodBase,
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
        TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      }).TURNSTILE_SECRET_KEY,
    ).toBe('1x0000000000000000000000000000000AA');
  });

  it('requires RESEND_FROM when a real Resend key is set', () => {
    expect(() => parseEnv({ ...prodBase, RESEND_API_KEY: 're_live_xxx' })).toThrow(
      /Invalid environment variables/,
    );
  });

  it('keeps RESEND_FROM optional in outbox mode', () => {
    expect(parseEnv({ ...prodBase, RESEND_API_KEY: 'test' }).RESEND_FROM).toBeUndefined();
    expect(parseEnv(prodBase).RESEND_FROM).toBeUndefined();
  });

  it('rejects documented placeholder setup and auth secrets', () => {
    expect(() =>
      parseEnv({ ...prodBase, SETUP_BOOTSTRAP_SECRET: 'replace-me-with-a-16+-char-random-string' }),
    ).toThrow(/Invalid environment variables/);
    expect(() =>
      parseEnv({ ...prodBase, SETUP_BOOTSTRAP_SECRET: 'dev-setup-bootstrap-secret' }),
    ).toThrow(/Invalid environment variables/);
    expect(() =>
      parseEnv({
        ...prodBase,
        AUTH_SECRET: 'DEV_ONLY-not-secret-set-AUTH_SECRET-in-production-please',
      }),
    ).toThrow(/Invalid environment variables/);
  });

  it('fails closed when FAMILIES is set but unparsable', () => {
    expect(() => parseEnv({ ...prodBase, FAMILIES: '{not json' })).toThrow(
      /Invalid environment variables/,
    );
  });

  it('accepts a valid leftover FAMILIES value', () => {
    expect(() =>
      parseEnv({
        ...prodBase,
        FAMILIES: JSON.stringify([{ child: 'alex@example.com', parents: ['pat@example.com'] }]),
      }),
    ).not.toThrow();
  });
});

describe('parseEnv dev/test defaults', () => {
  it('supplies a setup secret when NODE_ENV is not production', () => {
    const parsed = parseEnv({ NODE_ENV: 'test' });
    expect(parsed.SETUP_BOOTSTRAP_SECRET.length).toBeGreaterThanOrEqual(16);
  });
});

describe('allowLocalMailOutbox', () => {
  const original = {
    NODE_ENV: env.NODE_ENV,
    RESEND_API_KEY: env.RESEND_API_KEY,
    ALLOW_LOCAL_OUTBOX: env.ALLOW_LOCAL_OUTBOX,
  };
  afterEach(() => {
    (env as { NODE_ENV: typeof env.NODE_ENV }).NODE_ENV = original.NODE_ENV;
    (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = original.RESEND_API_KEY;
    (env as { ALLOW_LOCAL_OUTBOX?: boolean }).ALLOW_LOCAL_OUTBOX = original.ALLOW_LOCAL_OUTBOX;
  });

  it('is off in production unless ALLOW_LOCAL_OUTBOX is set', () => {
    (env as { NODE_ENV: typeof env.NODE_ENV }).NODE_ENV = 'production';
    (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = undefined;
    (env as { ALLOW_LOCAL_OUTBOX?: boolean }).ALLOW_LOCAL_OUTBOX = undefined;
    expect(allowLocalMailOutbox()).toBe(false);
    (env as { ALLOW_LOCAL_OUTBOX?: boolean }).ALLOW_LOCAL_OUTBOX = true;
    expect(allowLocalMailOutbox()).toBe(true);
  });

  it('stays on when RESEND_API_KEY=test', () => {
    (env as { NODE_ENV: typeof env.NODE_ENV }).NODE_ENV = 'production';
    (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = 'test';
    (env as { ALLOW_LOCAL_OUTBOX?: boolean }).ALLOW_LOCAL_OUTBOX = undefined;
    expect(allowLocalMailOutbox()).toBe(true);
  });
});
