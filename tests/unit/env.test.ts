import { afterEach, describe, expect, it } from 'vitest';
import {
  allowLocalMailOutbox,
  canDeliverMailboxProof,
  env,
  getAuthMode,
  parseEnv,
  resolveMailTransport,
} from '@/lib/env';

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

  it('fails closed on an unrecognized ALLOW_LOCAL_OUTBOX value', () => {
    expect(() => parseEnv({ ...prodBase, ALLOW_LOCAL_OUTBOX: 'treu' })).toThrow(
      /Invalid environment variables/,
    );
  });

  it('accepts explicit ALLOW_LOCAL_OUTBOX booleans', () => {
    expect(parseEnv({ ...prodBase, ALLOW_LOCAL_OUTBOX: '1' }).ALLOW_LOCAL_OUTBOX).toBe(true);
    expect(
      parseEnv({ ...prodBase, ALLOW_LOCAL_OUTBOX: 'false' }).ALLOW_LOCAL_OUTBOX,
    ).toBeUndefined();
  });

  it('defaults AUTH_MODE to magic-link and accepts password / local-otp', () => {
    expect(parseEnv(prodBase).AUTH_MODE).toBe('magic-link');
    expect(parseEnv({ ...prodBase, AUTH_MODE: 'password' }).AUTH_MODE).toBe('password');
    expect(
      parseEnv({
        ...prodBase,
        AUTH_MODE: 'local-otp',
        ALLOW_LOCAL_OUTBOX: '1',
      }).AUTH_MODE,
    ).toBe('local-otp');
  });

  it('requires ALLOW_LOCAL_OUTBOX for local-otp or explicit outbox in production', () => {
    expect(() => parseEnv({ ...prodBase, AUTH_MODE: 'local-otp' })).toThrow(
      /Invalid environment variables/,
    );
    expect(() => parseEnv({ ...prodBase, MAIL_TRANSPORT: 'outbox' })).toThrow(
      /Invalid environment variables/,
    );
  });

  it('requires SMTP_HOST and SMTP_FROM when MAIL_TRANSPORT=smtp', () => {
    expect(() => parseEnv({ ...prodBase, MAIL_TRANSPORT: 'smtp' })).toThrow(
      /Invalid environment variables/,
    );
    expect(() =>
      parseEnv({ ...prodBase, MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com' }),
    ).toThrow(/Invalid environment variables/);
    expect(
      parseEnv({
        ...prodBase,
        MAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_FROM: 'Examify <examify@example.com>',
      }).SMTP_HOST,
    ).toBe('smtp.example.com');
  });

  it('requires a real Resend key when MAIL_TRANSPORT=resend', () => {
    expect(() => parseEnv({ ...prodBase, MAIL_TRANSPORT: 'resend' })).toThrow(
      /Invalid environment variables/,
    );
    expect(() =>
      parseEnv({ ...prodBase, MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'test' }),
    ).toThrow(/Invalid environment variables/);
    expect(
      parseEnv({
        ...prodBase,
        MAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: 're_live_xxx',
        RESEND_FROM: 'Examify <examify@example.com>',
      }).MAIL_TRANSPORT,
    ).toBe('resend');
  });

  it('does not require SMTP_FROM for resend/outbox when SMTP_HOST is leftover', () => {
    expect(
      parseEnv({
        ...prodBase,
        MAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: 're_live_xxx',
        RESEND_FROM: 'Examify <examify@example.com>',
        SMTP_HOST: 'smtp.example.com',
      }).SMTP_FROM,
    ).toBeUndefined();
    expect(
      parseEnv({
        ...prodBase,
        MAIL_TRANSPORT: 'outbox',
        ALLOW_LOCAL_OUTBOX: '1',
        SMTP_HOST: 'smtp.example.com',
      }).SMTP_HOST,
    ).toBe('smtp.example.com');
  });

  it('requires SMTP_FROM when MAIL_TRANSPORT=auto and SMTP_HOST is set', () => {
    expect(() =>
      parseEnv({ ...prodBase, MAIL_TRANSPORT: 'auto', SMTP_HOST: 'smtp.example.com' }),
    ).toThrow(/Invalid environment variables/);
  });

  it('accepts leftover FAMILIES that includes a standalone child (import skips it)', () => {
    expect(() =>
      parseEnv({
        ...prodBase,
        FAMILIES: JSON.stringify([
          { child: 'alex@example.com', parents: ['pat@example.com'] },
          { child: 'jess@example.com', parents: [] },
        ]),
      }),
    ).not.toThrow();
  });
});

describe('getAuthMode + resolveMailTransport', () => {
  const original = {
    AUTH_MODE: env.AUTH_MODE,
    MAIL_TRANSPORT: env.MAIL_TRANSPORT,
    SMTP_HOST: env.SMTP_HOST,
    RESEND_API_KEY: env.RESEND_API_KEY,
  };
  afterEach(() => {
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = original.AUTH_MODE;
    (env as { MAIL_TRANSPORT: typeof env.MAIL_TRANSPORT }).MAIL_TRANSPORT = original.MAIL_TRANSPORT;
    (env as { SMTP_HOST?: string }).SMTP_HOST = original.SMTP_HOST;
    (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = original.RESEND_API_KEY;
  });

  it('reads AUTH_MODE from the parsed env singleton', () => {
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'password';
    expect(getAuthMode()).toBe('password');
  });

  it('auto-picks SMTP, then Resend, then outbox', () => {
    (env as { MAIL_TRANSPORT: typeof env.MAIL_TRANSPORT }).MAIL_TRANSPORT = 'auto';
    (env as { SMTP_HOST?: string }).SMTP_HOST = 'smtp.example.com';
    (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = undefined;
    expect(resolveMailTransport()).toBe('smtp');

    (env as { SMTP_HOST?: string }).SMTP_HOST = undefined;
    (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = 're_live';
    expect(resolveMailTransport()).toBe('resend');

    (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = 'test';
    expect(resolveMailTransport()).toBe('outbox');
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

  it('does not treat RESEND_API_KEY=test as a production outbox opt-in', () => {
    (env as { NODE_ENV: typeof env.NODE_ENV }).NODE_ENV = 'production';
    (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = 'test';
    (env as { ALLOW_LOCAL_OUTBOX?: boolean }).ALLOW_LOCAL_OUTBOX = undefined;
    expect(allowLocalMailOutbox()).toBe(false);
    (env as { ALLOW_LOCAL_OUTBOX?: boolean }).ALLOW_LOCAL_OUTBOX = true;
    expect(allowLocalMailOutbox()).toBe(true);
  });

  it('keeps the test-key outbox on outside production', () => {
    (env as { NODE_ENV: typeof env.NODE_ENV }).NODE_ENV = 'development';
    (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = 'test';
    (env as { ALLOW_LOCAL_OUTBOX?: boolean }).ALLOW_LOCAL_OUTBOX = undefined;
    expect(allowLocalMailOutbox()).toBe(true);
  });

  it('refuses mailbox proof in production without a real transport or outbox opt-in', () => {
    (env as { NODE_ENV: typeof env.NODE_ENV }).NODE_ENV = 'production';
    (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = undefined;
    (env as { ALLOW_LOCAL_OUTBOX?: boolean }).ALLOW_LOCAL_OUTBOX = undefined;
    expect(canDeliverMailboxProof()).toBe(false);
    (env as { ALLOW_LOCAL_OUTBOX?: boolean }).ALLOW_LOCAL_OUTBOX = true;
    expect(canDeliverMailboxProof()).toBe(true);
  });
});
