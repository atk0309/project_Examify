import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  allowLocalMailOutbox,
  canDeliverMailboxProof,
  env,
  getAuthMode,
  isHttpsSiteUrl,
  parseEnv,
  resolveMailTransport,
  sessionCookieConfig,
} from '@/lib/env';

// Production parses check the data folder on disk (safety, a dedicated
// folder), so every path here lives under a fresh temp folder — never a real
// host path such as /data or this checkout's ./data.
const prodRoot = mkdtempSync(path.join(tmpdir(), 'examify-env-prod-'));
afterAll(() => rmSync(prodRoot, { recursive: true, force: true }));
/** A family data folder that does not exist yet (a fresh volume). */
const prodDataDir = path.join(prodRoot, 'family-data');

const prodBase: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  SITE_URL: 'https://examify.example.com',
  DATABASE_URL: `file:${path.join(prodDataDir, 'app.db')}`,
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

  it('rejects exactly one Turnstile key in production', () => {
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

  it('requires both Turnstile keys when TURNSTILE_ENABLED=1', () => {
    expect(() => parseEnv({ ...prodBase, TURNSTILE_ENABLED: '1' })).toThrow(
      /Invalid environment variables/,
    );
    expect(
      parseEnv({
        ...prodBase,
        TURNSTILE_ENABLED: '1',
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
        TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      }).TURNSTILE_ENABLED,
    ).toBe(true);
  });

  it('allows both Turnstile keys unset or both set while captcha stays off without the flag', () => {
    expect(parseEnv(prodBase).SETUP_BOOTSTRAP_SECRET).toBe('production-setup-secret');
    expect(parseEnv(prodBase).TURNSTILE_ENABLED).toBeUndefined();
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

  it('keeps EXAMIFY_LLM_BASE_URL optional and rejects a non-URL', () => {
    expect(parseEnv(prodBase).EXAMIFY_LLM_BASE_URL).toBeUndefined();
    expect(
      parseEnv({ ...prodBase, EXAMIFY_LLM_BASE_URL: 'http://127.0.0.1:11434' })
        .EXAMIFY_LLM_BASE_URL,
    ).toBe('http://127.0.0.1:11434');
    expect(() => parseEnv({ ...prodBase, EXAMIFY_LLM_BASE_URL: 'not-a-url' })).toThrow(
      /Invalid environment variables/,
    );
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

  it('defaults CLIENT_IP_HEADER to x-forwarded-for and accepts the opt-in headers', () => {
    expect(parseEnv(prodBase).CLIENT_IP_HEADER).toBe('x-forwarded-for');
    expect(parseEnv({ ...prodBase, CLIENT_IP_HEADER: '' }).CLIENT_IP_HEADER).toBe(
      'x-forwarded-for',
    );
    expect(parseEnv({ ...prodBase, CLIENT_IP_HEADER: 'x-real-ip' }).CLIENT_IP_HEADER).toBe(
      'x-real-ip',
    );
    expect(parseEnv({ ...prodBase, CLIENT_IP_HEADER: ' CF-Connecting-IP ' }).CLIENT_IP_HEADER).toBe(
      'cf-connecting-ip',
    );
  });

  it('fails boot on an unknown CLIENT_IP_HEADER instead of guessing', () => {
    expect(() => parseEnv({ ...prodBase, CLIENT_IP_HEADER: 'true-client-ip' })).toThrow(
      /Invalid environment variables/,
    );
    expect(() => parseEnv({ NODE_ENV: 'test', CLIENT_IP_HEADER: 'x-forwarded' })).toThrow(
      /Invalid environment variables/,
    );
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

  it('keeps ANTHROPIC_API_KEY optional after wizard clear (restart does not brick)', () => {
    const afterClear = { ...prodBase };
    delete afterClear.ANTHROPIC_API_KEY;
    const parsed = parseEnv(afterClear);
    expect(parsed.ANTHROPIC_API_KEY).toBeUndefined();
    expect('OPENAI_API_KEY' in parsed).toBe(false);
    expect(parseEnv({ ...prodBase, ANTHROPIC_API_KEY: '' }).ANTHROPIC_API_KEY).toBeUndefined();
    expect(parseEnv({ ...prodBase, ANTHROPIC_API_KEY: '   ' }).ANTHROPIC_API_KEY).toBeUndefined();
    expect(parseEnv(prodBase).ANTHROPIC_API_KEY).toBe('sk-ant-real');
    expect(parseEnv({ ...prodBase, ANTHROPIC_API_KEY: 'test' }).ANTHROPIC_API_KEY).toBe('test');
  });
});

describe('parseEnv family data folder', () => {
  const withoutDb: NodeJS.ProcessEnv = { ...prodBase };
  delete withoutDb.DATABASE_URL;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function loggedIssues(run: () => unknown): string {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(run).toThrow(/Invalid environment variables/);
    const logged = error.mock.calls.map((call) => String(call[0])).join('\n');
    error.mockRestore();
    return logged;
  }

  it('fails production boot when neither EXAMIFY_DATA_DIR nor DATABASE_URL is set', () => {
    for (const env of [
      withoutDb,
      { ...withoutDb, EXAMIFY_DATA_DIR: '   ', DATABASE_URL: '' },
    ] as NodeJS.ProcessEnv[]) {
      expect(loggedIssues(() => parseEnv(env))).toContain(
        'Set EXAMIFY_DATA_DIR (or DATABASE_URL) in production',
      );
    }
  });

  it('accepts either EXAMIFY_DATA_DIR or an explicit DATABASE_URL in production', () => {
    const absolute = path.join(prodRoot, 'var-lib-examify');
    expect(parseEnv({ ...withoutDb, EXAMIFY_DATA_DIR: absolute }).EXAMIFY_DATA_DIR).toBe(absolute);
    // Relative (to the checkout), like ./data, but a folder no one else uses.
    const relative = path.relative(process.cwd(), path.join(prodRoot, 'data'));
    expect(parseEnv({ ...withoutDb, EXAMIFY_DATA_DIR: relative }).DATABASE_URL).toBeUndefined();
    expect(parseEnv(prodBase).DATABASE_URL).toBe(prodBase.DATABASE_URL);
    expect(parseEnv(prodBase).EXAMIFY_DATA_DIR).toBeUndefined();
  });

  it('fails production boot on an unsafe data folder without naming the path', () => {
    const checkout = process.cwd();
    for (const value of ['src/family', '.', '~/examify', path.dirname(checkout)]) {
      const logged = loggedIssues(() => parseEnv({ ...withoutDb, EXAMIFY_DATA_DIR: value }));
      expect(logged).toMatch(/EXAMIFY_DATA_DIR: .*(family data folder|starts with ~)/);
      expect(logged).not.toContain(checkout);
    }
  });

  it('fails production boot on a folder shared with other software, without naming it', () => {
    const shared = mkdtempSync(path.join(tmpdir(), 'examify-env-shared-'));
    try {
      writeFileSync(path.join(shared, 'someone-else.conf'), 'x');
      for (const env of [
        { ...withoutDb, EXAMIFY_DATA_DIR: shared },
        { ...withoutDb, DATABASE_URL: `file:${path.join(shared, 'examify.db')}` },
      ] as NodeJS.ProcessEnv[]) {
        const logged = loggedIssues(() => parseEnv(env));
        expect(logged).toContain('already holds files that are not Examify');
        expect(logged).not.toContain(shared);
      }
      // A marked folder is Examify's, whatever else it holds.
      writeFileSync(path.join(shared, '.examify-data.json'), '{"layout":1}');
      expect(() => parseEnv({ ...withoutDb, EXAMIFY_DATA_DIR: shared })).not.toThrow();
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });

  it('fails production boot on a database or mail outbox inside the checkout, without naming it', () => {
    const checkout = process.cwd();
    const cases: Array<[NodeJS.ProcessEnv, string]> = [
      [{ ...withoutDb, DATABASE_URL: 'file:./app.db' }, 'DATABASE_URL points inside the checkout'],
      [
        { ...withoutDb, DATABASE_URL: 'file:./src/examify.db', EXAMIFY_DATA_DIR: prodDataDir },
        'DATABASE_URL points inside the checkout',
      ],
      [{ ...prodBase, MAIL_OUTBOX_DIR: 'outbox' }, 'MAIL_OUTBOX_DIR points inside the checkout'],
      [{ ...prodBase, MAIL_OUTBOX_DIR: '.' }, 'MAIL_OUTBOX_DIR points inside the checkout'],
    ];
    for (const [env, message] of cases) {
      const logged = loggedIssues(() => parseEnv(env));
      expect(logged).toContain(message);
      expect(logged).not.toContain(checkout);
    }
    // Outside the checkout (or under tests/.tmp, the suites' folder) is fine.
    expect(() =>
      parseEnv({ ...prodBase, MAIL_OUTBOX_DIR: path.join(prodRoot, 'outbox') }),
    ).not.toThrow();
    const suiteDb = `file:./tests/.tmp/env-prod-${path.basename(prodRoot)}/app.db`;
    expect(() =>
      parseEnv({ ...withoutDb, EXAMIFY_DATA_DIR: prodDataDir, DATABASE_URL: suiteDb }),
    ).not.toThrow();
  });

  it('leaves the data folder to the resolver default outside production and in next build', () => {
    const dev = parseEnv({ NODE_ENV: 'development' });
    expect(dev.EXAMIFY_DATA_DIR).toBeUndefined();
    expect(dev.DATABASE_URL).toBeUndefined();
    expect(() => parseEnv({ ...withoutDb, NEXT_PHASE: 'phase-production-build' })).not.toThrow();
  });
});

describe('session cookie follows SITE_URL', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is Secure with a __Host- default name on an https SITE_URL', () => {
    expect(sessionCookieConfig(parseEnv(prodBase))).toEqual({
      name: '__Host-examify_session',
      secure: true,
    });
    expect(
      sessionCookieConfig(
        parseEnv({ NODE_ENV: 'development', SITE_URL: 'https://localhost:3443' }),
      ),
    ).toEqual({ name: '__Host-examify_session', secure: true });
  });

  it('is not Secure and drops the __Host- prefix on a plain-http LAN SITE_URL in production', () => {
    const parsed = parseEnv({ ...prodBase, SITE_URL: 'http://192.168.1.20:3000' });
    expect(parsed.SESSION_COOKIE_NAME).toBeUndefined();
    expect(sessionCookieConfig(parsed)).toEqual({ name: 'examify_session', secure: false });
  });

  it('keys Secure off SITE_URL, not NODE_ENV (pnpm dev on http://localhost)', () => {
    expect(sessionCookieConfig(parseEnv({ NODE_ENV: 'development' }))).toEqual({
      name: 'examify_session',
      secure: false,
    });
    expect(sessionCookieConfig(parseEnv({ NODE_ENV: 'test' })).secure).toBe(false);
  });

  it('treats a blank SESSION_COOKIE_NAME as unset', () => {
    expect(
      sessionCookieConfig(
        parseEnv({ ...prodBase, SITE_URL: 'http://192.168.1.20:3000', SESSION_COOKIE_NAME: '  ' }),
      ).name,
    ).toBe('examify_session');
  });

  it('respects an explicit SESSION_COOKIE_NAME on either scheme', () => {
    expect(
      sessionCookieConfig(parseEnv({ ...prodBase, SESSION_COOKIE_NAME: 'family_exam' })),
    ).toEqual({ name: 'family_exam', secure: true });
    expect(
      sessionCookieConfig(
        parseEnv({
          ...prodBase,
          SITE_URL: 'http://192.168.1.20:3000',
          SESSION_COOKIE_NAME: 'family_exam',
        }),
      ),
    ).toEqual({ name: 'family_exam', secure: false });
    expect(
      sessionCookieConfig(parseEnv({ ...prodBase, SESSION_COOKIE_NAME: '__Secure-family' })),
    ).toEqual({ name: '__Secure-family', secure: true });
  });

  it('refuses production boot for an explicit __Host- / __Secure- name on a plain-http SITE_URL', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const name of ['__Host-examify_session', '__Secure-examify', '__host-lowercase']) {
      expect(() =>
        parseEnv({ ...prodBase, SITE_URL: 'http://192.168.1.20:3000', SESSION_COOKIE_NAME: name }),
      ).toThrow(/Invalid environment variables/);
    }
    const logged = error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('SESSION_COOKIE_NAME');
    expect(logged).toContain('needs an https SITE_URL');
    expect(logged).toContain('Unset SESSION_COOKIE_NAME');
  });

  it('keeps an explicit __Host- name on plain http outside production, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseEnv({
      NODE_ENV: 'development',
      SITE_URL: 'http://localhost:3000',
      SESSION_COOKIE_NAME: '__Host-examify_session',
    });
    expect(sessionCookieConfig(parsed)).toEqual({
      name: '__Host-examify_session',
      secure: false,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('needs an https SITE_URL');
  });

  it('does not warn for the derived default or an https SITE_URL', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseEnv({ NODE_ENV: 'development' });
    parseEnv({ ...prodBase, SESSION_COOKIE_NAME: '__Host-examify_session' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('only treats https: as a secure SITE_URL', () => {
    expect(isHttpsSiteUrl('https://exam.example.com')).toBe(true);
    expect(isHttpsSiteUrl('HTTPS://exam.example.com')).toBe(true);
    expect(isHttpsSiteUrl('http://exam.example.com')).toBe(false);
    expect(isHttpsSiteUrl('not a url')).toBe(false);
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

  it('does not coerce missing or blank ANTHROPIC_API_KEY to the test sentinel', () => {
    expect(parseEnv({ NODE_ENV: 'test' }).ANTHROPIC_API_KEY).toBeUndefined();
    expect(parseEnv({ NODE_ENV: 'development' }).ANTHROPIC_API_KEY).toBeUndefined();
    expect(parseEnv({ NODE_ENV: 'test', ANTHROPIC_API_KEY: '' }).ANTHROPIC_API_KEY).toBeUndefined();
    expect(
      parseEnv({ NODE_ENV: 'development', ANTHROPIC_API_KEY: '   ' }).ANTHROPIC_API_KEY,
    ).toBeUndefined();
    expect(parseEnv({ NODE_ENV: 'test', ANTHROPIC_API_KEY: 'test' }).ANTHROPIC_API_KEY).toBe(
      'test',
    );
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
