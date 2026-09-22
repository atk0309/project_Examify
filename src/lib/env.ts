import { z } from 'zod';
import {
  AUTH_MODES,
  MAIL_TRANSPORTS,
  type AuthMode,
  type ResolvedMailTransport,
} from './auth-mode';
import { parseFamilies } from './families';

/**
 * In production, security-critical env vars have no defaults — boot fails
 * closed if any is missing. In dev/test, dev defaults apply so `pnpm dev` and
 * the unit tests work out of the box.
 *
 * The strict-mode flag explicitly excludes `next build`, because the build
 * doesn't need real secrets (they aren't bundled — env.ts is evaluated at
 * production server-start time, and again at build time when Next.js does
 * page-data collection). `NEXT_PHASE=phase-production-build` covers that
 * case. The actual runtime server runs under
 * `NEXT_PHASE=phase-production-server`, where the strict check applies.
 *
 * Raw `process.env.NODE_ENV` is used rather than the parsed value because
 * we need to know whether to attach defaults *before* parsing.
 */

/** Treat empty / whitespace-only strings as unset. */
function emptyToUndef(v: unknown): unknown {
  if (typeof v === 'string' && v.trim() === '') return undefined;
  return v;
}

function isConfiguredSecret(key: string | undefined): boolean {
  const trimmed = key?.trim();
  return Boolean(trimmed && trimmed !== 'test');
}

/** Documented / generated placeholders that must never ship in production. */
const PLACEHOLDER_SETUP_SECRETS = new Set([
  'dev-setup-bootstrap-secret',
  'build-placeholder-setup',
  'replace-me-with-a-16+-char-random-string',
]);

const PLACEHOLDER_AUTH_SECRETS = new Set([
  'dev_only-not-secret-set-auth_secret-in-production-please',
  'build-placeholder-auth-secret-32ch',
  'replace-me-with-a-32+-char-random-string',
]);

function looksLikePlaceholderSecret(value: string, extra: Set<string>): boolean {
  const normalised = value.trim().toLowerCase();
  if (extra.has(normalised)) return true;
  return normalised.includes('replace-me') || normalised.includes('changeme');
}

/** Browsers only accept a `__Host-` / `__Secure-` cookie when it is Secure. */
const SECURE_ONLY_COOKIE_PREFIX = /^__(host|secure)-/i;

/**
 * Whether SITE_URL is an https origin. The session cookie is Secure exactly
 * when this is true — never keyed off NODE_ENV — so a plain-http LAN host or
 * `pnpm dev` still gets a cookie the browser keeps.
 */
export function isHttpsSiteUrl(siteUrl: string): boolean {
  try {
    return new URL(siteUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

function isSecureOnlyCookieName(name: string): boolean {
  return SECURE_ONLY_COOKIE_PREFIX.test(name);
}

function secureOnlyCookieOnHttpMessage(name: string): string {
  return `SESSION_COOKIE_NAME=${name} needs an https SITE_URL: browsers drop a __Host- / __Secure- cookie that is not Secure, and the session cookie is Secure only when SITE_URL is https, so sign-in would bounce back to /signin. Unset SESSION_COOKIE_NAME (plain http defaults to examify_session) or serve the app over HTTPS and set SITE_URL to that https:// origin.`;
}

/**
 * Which request header carries the real client IP (see `src/lib/ip.ts`).
 * `x-forwarded-for` reads its rightmost entry — the hop the nearest proxy
 * appended. The other two are read only when the host opts in.
 */
export const CLIENT_IP_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'] as const;
export type ClientIpHeader = (typeof CLIENT_IP_HEADERS)[number];

function isProductionRuntime(raw: NodeJS.ProcessEnv): boolean {
  const isBuild = (raw.NEXT_PHASE ?? process.env.NEXT_PHASE) === 'phase-production-build';
  return raw.NODE_ENV === 'production' && !isBuild;
}

function buildEnvSchema(isProd: boolean) {
  // Dev/test defaults. Applied only when this parse is not a production
  // runtime. In production these vars must be set explicitly.
  const dev = <T extends string>(value: T): T | undefined => (isProd ? undefined : value);

  return z
    .object({
      NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

      // Public app URL supplied at runtime. Drives absolute URLs in magic-link
      // sign-in emails and invite links, and whether the session cookie is
      // Secure (https only — see sessionCookieConfig).
      SITE_URL: z.preprocess((v) => v ?? dev('http://localhost:3000'), z.string().url()),

      // SQLite file path. In production, point this at runtime-mounted persistent storage.
      DATABASE_URL: z.preprocess((v) => v ?? dev('file:./data/app.db'), z.string().min(1)),

      // Signs the session cookie. If this falls back to a known value in
      // production, an attacker can forge a signed-in session.
      AUTH_SECRET: z.preprocess(
        (v) => v ?? dev('DEV_ONLY-not-secret-set-AUTH_SECRET-in-production-please'),
        z.string().min(32),
      ),

      // Optional override. Unset follows SITE_URL: `__Host-examify_session`
      // on https, `examify_session` on plain http (a `__Host-` / `__Secure-`
      // cookie is dropped without Secure). See sessionCookieConfig.
      SESSION_COOKIE_NAME: z.preprocess(emptyToUndef, z.string().min(1).optional()),

      // Access is invite-only households in SQLite — there is no FAMILIES env
      // allowlist. A leftover FAMILIES value is imported once when the DB has
      // no households. Production boot fails if FAMILIES is set and invalid.

      // How people sign in. Default magic-link keeps existing #56 hosts working.
      // `password` sign-in needs no mail; invite accept still sends a mailbox
      // OTP. `local-otp` writes a 6-digit code to the outbox (prod requires
      // ALLOW_LOCAL_OUTBOX).
      AUTH_MODE: z.preprocess((v) => emptyToUndef(v) ?? 'magic-link', z.enum(AUTH_MODES)),

      // How magic-link / OTP messages are delivered. `auto` picks SMTP when
      // SMTP_HOST is set, else Resend when a real key is set, else outbox.
      MAIL_TRANSPORT: z.preprocess((v) => emptyToUndef(v) ?? 'auto', z.enum(MAIL_TRANSPORTS)),

      // Resend: optional. Unset or the `test` sentinel writes emails to a
      // local outbox instead of sending (dev/test, and a self-hosted box that
      // has not configured email yet). A real (non-test) key requires RESEND_FROM.
      RESEND_API_KEY: z.preprocess(emptyToUndef, z.string().min(1).optional()),
      RESEND_FROM: z.preprocess(emptyToUndef, z.string().min(1).optional()),

      // User-configured SMTP (magic-link / OTP). SMTP_FROM is required when
      // MAIL_TRANSPORT is `smtp`, or `auto` and SMTP_HOST is set. A leftover
      // SMTP_HOST is ignored for resend/outbox and does not require FROM.
      SMTP_HOST: z.preprocess(emptyToUndef, z.string().min(1).optional()),
      SMTP_PORT: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).max(65535).optional()),
      SMTP_SECURE: z.preprocess((v) => {
        if (v === undefined) return undefined;
        if (typeof v !== 'string') return v;
        const t = v.trim().toLowerCase();
        if (t === '1' || t === 'true') return true;
        if (t === '' || t === '0' || t === 'false') return false;
        return v;
      }, z.boolean().optional()),
      SMTP_USER: z.preprocess(emptyToUndef, z.string().min(1).optional()),
      SMTP_PASS: z.preprocess(emptyToUndef, z.string().min(1).optional()),
      SMTP_FROM: z.preprocess(emptyToUndef, z.string().min(1).optional()),
      // Opt-in for AUTH/DATA on a connection that never upgraded to TLS.
      SMTP_ALLOW_INSECURE: z.preprocess((v) => {
        if (v === undefined) return undefined;
        if (typeof v !== 'string') return v;
        const t = v.trim().toLowerCase();
        if (t === '1' || t === 'true') return true;
        if (t === '' || t === '0' || t === 'false') return false;
        return v;
      }, z.boolean().optional()),

      // Optional override for the local mail outbox directory (writer + test
      // readers share this). Unset keeps the existing defaults.
      MAIL_OUTBOX_DIR: z.preprocess(emptyToUndef, z.string().min(1).optional()),

      // Production: writing magic-link bearer tokens to a local outbox is off
      // unless this is explicitly enabled. Dev/test do not need it. The
      // RESEND_API_KEY=test sentinel does not bypass this in production.
      ALLOW_LOCAL_OUTBOX: z.preprocess((v) => {
        if (v === undefined) return undefined;
        if (typeof v !== 'string') return v;
        const t = v.trim().toLowerCase();
        if (t === '1' || t === 'true') return true;
        if (t === '' || t === '0' || t === 'false') return undefined;
        return v;
      }, z.boolean().optional()),

      // Anthropic key for free-text grading and /onboarding Cloud generate.
      // Optional — same spirit as OPENAI_API_KEY (not in this schema). Wizard
      // clear deletes the store line; production restart must not crash.
      // Missing / empty / whitespace stay unset — never coerced to the `test`
      // sentinel. Only an explicit live `test` stubs the grader.
      ANTHROPIC_API_KEY: z.preprocess(emptyToUndef, z.string().min(1).optional()),

      // Optional local-agent endpoint for examify-ingest generate --provider local
      // (CLI and /onboarding AI step). Not a secret. Never expose via NEXT_PUBLIC_*.
      EXAMIFY_LLM_BASE_URL: z.preprocess(emptyToUndef, z.string().url().optional()),

      // Cloudflare Turnstile captcha. OFF by default — local / simple self-hosts
      // need no Cloudflare account. Set TURNSTILE_ENABLED=1 and both keys to
      // turn it on. Keys alone do not enable captcha. When enabled, both keys
      // are required (production boot fails closed on a partial pair).
      TURNSTILE_ENABLED: z.preprocess((v) => {
        if (v === undefined) return undefined;
        if (typeof v !== 'string') return v;
        const t = v.trim().toLowerCase();
        if (t === '1' || t === 'true') return true;
        if (t === '' || t === '0' || t === 'false') return undefined;
        return v;
      }, z.boolean().optional()),
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.preprocess(emptyToUndef, z.string().min(1).optional()),
      TURNSTILE_SECRET_KEY: z.preprocess(emptyToUndef, z.string().min(1).optional()),

      // Deployment-provided secret required to claim /setup. Production has no
      // default (min 16). CAPTCHA is not identity — a stranger on a fresh
      // deploy must not be able to become admin without this.
      SETUP_BOOTSTRAP_SECRET: z.preprocess(
        (v) => emptyToUndef(v) ?? dev('dev-setup-bootstrap-secret'),
        z.string().min(16),
      ),

      // Analytics is opt-in; absent value means no script renders.
      PLAUSIBLE_DOMAIN: z.string().optional(),
      PLAUSIBLE_SRC: z.string().optional(),

      // Sign-in rate-limit knob. A single per-IP bucket for every magic-link
      // request — see the no-enumeration note in src/actions/requestMagicLink.ts.
      // Defaults are reasonable; overrides are dev/ops choices.
      RATE_LIMIT_SIGNIN_MAX: z.coerce.number().int().positive().default(10),
      RATE_LIMIT_SIGNIN_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),

      // Header the rate limiter trusts for the client IP. Default reads the
      // rightmost X-Forwarded-For hop. `x-real-ip` / `cf-connecting-ip` are
      // client-settable unless your proxy overwrites them, so they are never
      // read unless chosen here. A typo fails boot rather than silently
      // falling back.
      CLIENT_IP_HEADER: z.preprocess(
        (v) =>
          emptyToUndef(typeof v === 'string' ? v.trim().toLowerCase() : v) ?? 'x-forwarded-for',
        z.enum(CLIENT_IP_HEADERS),
      ),
    })
    .superRefine((data, ctx) => {
      const hasSite = Boolean(data.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
      const hasSecret = Boolean(data.TURNSTILE_SECRET_KEY);
      if (data.TURNSTILE_ENABLED === true) {
        if (!hasSite || !hasSecret) {
          ctx.addIssue({
            code: 'custom',
            message:
              'TURNSTILE_ENABLED=1 requires both NEXT_PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY.',
            path: hasSite ? ['TURNSTILE_SECRET_KEY'] : ['NEXT_PUBLIC_TURNSTILE_SITE_KEY'],
          });
        }
      } else if (isProd && hasSite !== hasSecret) {
        // Leftover half-config while captcha is off — still fail closed so a
        // host that meant to enable Turnstile is not left with a silent skip.
        ctx.addIssue({
          code: 'custom',
          message:
            'Turnstile keys must both be set or both omitted. To enable captcha set TURNSTILE_ENABLED=1 with both keys; otherwise remove the leftover key.',
          path: hasSite ? ['TURNSTILE_SECRET_KEY'] : ['NEXT_PUBLIC_TURNSTILE_SITE_KEY'],
        });
      }
      if (isConfiguredSecret(data.RESEND_API_KEY) && !data.RESEND_FROM) {
        ctx.addIssue({
          code: 'custom',
          message: 'RESEND_FROM is required when RESEND_API_KEY is a real (non-test) key.',
          path: ['RESEND_FROM'],
        });
      }
      if (data.MAIL_TRANSPORT === 'resend' && !isConfiguredSecret(data.RESEND_API_KEY)) {
        ctx.addIssue({
          code: 'custom',
          message: 'MAIL_TRANSPORT=resend requires a real (non-test) RESEND_API_KEY.',
          path: ['RESEND_API_KEY'],
        });
      }
      if (data.MAIL_TRANSPORT === 'smtp' && !data.SMTP_HOST) {
        ctx.addIssue({
          code: 'custom',
          message: 'MAIL_TRANSPORT=smtp requires SMTP_HOST.',
          path: ['SMTP_HOST'],
        });
      }
      const smtpActive =
        data.MAIL_TRANSPORT === 'smtp' ||
        (data.MAIL_TRANSPORT === 'auto' && Boolean(data.SMTP_HOST));
      if (smtpActive && !data.SMTP_FROM) {
        ctx.addIssue({
          code: 'custom',
          message: 'SMTP_FROM is required when SMTP is the active mail transport.',
          path: ['SMTP_FROM'],
        });
      }
      if (isProd && data.AUTH_MODE === 'local-otp' && data.ALLOW_LOCAL_OUTBOX !== true) {
        ctx.addIssue({
          code: 'custom',
          message:
            'AUTH_MODE=local-otp in production requires ALLOW_LOCAL_OUTBOX=1 (codes are written to disk).',
          path: ['ALLOW_LOCAL_OUTBOX'],
        });
      }
      if (isProd && data.MAIL_TRANSPORT === 'outbox' && data.ALLOW_LOCAL_OUTBOX !== true) {
        ctx.addIssue({
          code: 'custom',
          message: 'MAIL_TRANSPORT=outbox in production requires ALLOW_LOCAL_OUTBOX=1.',
          path: ['ALLOW_LOCAL_OUTBOX'],
        });
      }
      if (
        isProd &&
        looksLikePlaceholderSecret(data.SETUP_BOOTSTRAP_SECRET, PLACEHOLDER_SETUP_SECRETS)
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'SETUP_BOOTSTRAP_SECRET is a documented placeholder. Set a unique random value in production (openssl rand -base64 24).',
          path: ['SETUP_BOOTSTRAP_SECRET'],
        });
      }
      if (
        isProd &&
        data.SESSION_COOKIE_NAME &&
        isSecureOnlyCookieName(data.SESSION_COOKIE_NAME) &&
        !isHttpsSiteUrl(data.SITE_URL)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: secureOnlyCookieOnHttpMessage(data.SESSION_COOKIE_NAME),
          path: ['SESSION_COOKIE_NAME'],
        });
      }
      if (isProd && looksLikePlaceholderSecret(data.AUTH_SECRET, PLACEHOLDER_AUTH_SECRETS)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'AUTH_SECRET is a documented placeholder. Set a unique random value in production (openssl rand -base64 32).',
          path: ['AUTH_SECRET'],
        });
      }
    });
}

export type Env = z.infer<ReturnType<typeof buildEnvSchema>>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const isProd = isProductionRuntime(raw);
  const parsed = buildEnvSchema(isProd).safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(
      `Invalid environment variables (NODE_ENV=${raw.NODE_ENV ?? process.env.NODE_ENV ?? 'unset'}):\n${issues}`,
    );
    throw new Error('Invalid environment variables');
  }

  // Outside production an explicit __Host- / __Secure- name on plain http is
  // kept as given (dev must not crash), but the browser will drop it.
  const cookieName = parsed.data.SESSION_COOKIE_NAME;
  if (
    !isProd &&
    cookieName &&
    isSecureOnlyCookieName(cookieName) &&
    !isHttpsSiteUrl(parsed.data.SITE_URL)
  ) {
    console.warn(`Warning: ${secureOnlyCookieOnHttpMessage(cookieName)}`);
  }

  const familiesRaw = raw.FAMILIES;
  if (isProd && familiesRaw && familiesRaw.trim() !== '' && familiesRaw.trim() !== '[]') {
    const families = parseFamilies(familiesRaw);
    if (!families.ok) {
      console.error(`Invalid FAMILIES env JSON: ${families.error}`);
      throw new Error('Invalid environment variables');
    }
  }

  return parsed.data;
}

export const env: Env = parseEnv();

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Session cookie name + Secure flag, both derived from SITE_URL. The one
 * place iron-session's cookie options come from, so setting, re-sealing, and
 * clearing (`session.destroy()`) always agree.
 *
 * - `secure` is true exactly when SITE_URL is https (not NODE_ENV): a browser
 *   drops a Secure cookie set over plain http, so a LAN self-host at
 *   `http://192.168.x.y:3000` would otherwise bounce to /signin forever.
 * - `name` is SESSION_COOKIE_NAME when set, else `__Host-examify_session` on
 *   https and `examify_session` on http (`__Host-` requires Secure).
 */
export function sessionCookieConfig(source: Pick<Env, 'SITE_URL' | 'SESSION_COOKIE_NAME'> = env): {
  name: string;
  secure: boolean;
} {
  const secure = isHttpsSiteUrl(source.SITE_URL);
  const name =
    source.SESSION_COOKIE_NAME ?? (secure ? '__Host-examify_session' : 'examify_session');
  return { name, secure };
}

/** Local outbox / stub path — no real Resend key configured. */
export function isResendConfigured(): boolean {
  return isConfiguredSecret(env.RESEND_API_KEY);
}

/**
 * Cloudflare Turnstile captcha. Off unless TURNSTILE_ENABLED=1 and both the
 * site key and secret are set. Local / simple self-hosts leave the flag unset.
 */
export function isTurnstileEnabled(): boolean {
  if (env.TURNSTILE_ENABLED !== true) return false;
  return Boolean(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() && env.TURNSTILE_SECRET_KEY?.trim());
}

/**
 * Whether magic-link emails may be written to a local outbox.
 * Always on in test and outside production (including RESEND_API_KEY=test).
 * Production writes only when ALLOW_LOCAL_OUTBOX is explicitly enabled —
 * the test-key sentinel is not an opt-in.
 */
export function allowLocalMailOutbox(): boolean {
  if (env.NODE_ENV === 'test') return true;
  if (env.NODE_ENV !== 'production') return true;
  return env.ALLOW_LOCAL_OUTBOX === true;
}

/**
 * Whether password-mode invite accept can deliver a mailbox-proof OTP.
 * SMTP / Resend need their required fields; the local outbox needs the
 * usual opt-in. Callers fail closed instead of trusting the invite URL.
 */
export function canDeliverMailboxProof(): boolean {
  const transport = resolveMailTransport();
  if (transport === 'smtp') return Boolean(env.SMTP_HOST && env.SMTP_FROM);
  if (transport === 'resend') return isResendConfigured() && Boolean(env.RESEND_FROM);
  return allowLocalMailOutbox();
}

export function getAuthMode(): AuthMode {
  return env.AUTH_MODE;
}

/** Where a person should look for a mailbox code on this host. Not per-address. */
export function mailboxDelivery(): 'inbox' | 'outbox' {
  return resolveMailTransport() === 'outbox' ? 'outbox' : 'inbox';
}

/**
 * Resolves an explicit mail transport or, in auto mode, prefers SMTP, then a
 * configured Resend account, and finally the local outbox.
 */
export function resolveMailTransport(): ResolvedMailTransport {
  if (
    env.MAIL_TRANSPORT === 'resend' ||
    env.MAIL_TRANSPORT === 'smtp' ||
    env.MAIL_TRANSPORT === 'outbox'
  ) {
    return env.MAIL_TRANSPORT;
  }
  if (env.SMTP_HOST) return 'smtp';
  if (isResendConfigured()) return 'resend';
  return 'outbox';
}
