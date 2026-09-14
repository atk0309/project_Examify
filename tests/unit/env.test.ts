import { describe, expect, it } from 'vitest';
import { parseEnv } from '@/lib/env';

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
});

describe('parseEnv dev/test defaults', () => {
  it('supplies a setup secret when NODE_ENV is not production', () => {
    const parsed = parseEnv({ NODE_ENV: 'test' });
    expect(parsed.SETUP_BOOTSTRAP_SECRET.length).toBeGreaterThanOrEqual(16);
  });
});
