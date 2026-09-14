import { z } from 'zod';
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
      // sign-in emails and invite links.
      SITE_URL: z.preprocess((v) => v ?? dev('http://localhost:3000'), z.string().url()),

      // SQLite file path. In production, point this at runtime-mounted persistent storage.
      DATABASE_URL: z.preprocess((v) => v ?? dev('file:./data/app.db'), z.string().min(1)),

      // Signs the session cookie. If this falls back to a known value in
      // production, an attacker can forge a signed-in session.
      AUTH_SECRET: z.preprocess(
        (v) => v ?? dev('DEV_ONLY-not-secret-set-AUTH_SECRET-in-production-please'),
        z.string().min(32),
      ),

      // Cookie name is not security-critical; default is fine everywhere.
      SESSION_COOKIE_NAME: z.string().min(1).default('__Host-examify_session'),

      // Access is invite-only households in SQLite — there is no FAMILIES env
      // allowlist. A leftover FAMILIES value is imported once when the DB has
      // no households. Production boot fails if FAMILIES is set and invalid.

      // Resend: optional. Unset or the `test` sentinel writes magic-link emails
      // to a local outbox instead of sending (dev/test, and a self-hosted box
      // that has not configured email yet). A missing key no longer fails boot —
      // the install wizard will later let hosts pick an auth/email mode.
      // TODO(multi-auth): passkeys / password / SMTP picker plug in alongside
      // this magic-link path; do not hard-require Resend when adding them.
      // A real (non-test) key requires RESEND_FROM — no onboarding@resend.dev fallback.
      RESEND_API_KEY: z.preprocess(emptyToUndef, z.string().min(1).optional()),
      RESEND_FROM: z.preprocess(emptyToUndef, z.string().min(1).optional()),

      // Optional override for the local mail outbox directory (writer + test
      // readers share this). Unset keeps the existing defaults.
      MAIL_OUTBOX_DIR: z.preprocess(emptyToUndef, z.string().min(1).optional()),

      // Production: writing magic-link bearer tokens to a local outbox is off
      // unless this is explicitly enabled. Dev/test/`RESEND_API_KEY=test` do
      // not need it.
      ALLOW_LOCAL_OUTBOX: z.preprocess((v) => {
        if (typeof v !== 'string') return undefined;
        const t = v.trim().toLowerCase();
        if (t === '1' || t === 'true') return true;
        if (t === '' || t === '0' || t === 'false') return undefined;
        return undefined;
      }, z.boolean().optional()),

      // Anthropic key for free-text grading. The `test` sentinel (dev/test default)
      // routes the grader to a deterministic full-score stub — no network — exactly
      // like the Resend outbox stub above. A missing key in production fails closed
      // so an exam never silently scores every free-text answer as full marks.
      ANTHROPIC_API_KEY: z.preprocess((v) => v ?? dev('test'), z.string().min(1)),

      // Turnstile is optional. Both site + secret must be set to enable captcha;
      // unset/empty skips the widget and server verification so sign-in still
      // works. Exactly one key in production crashes boot (partial config must
      // not silently disable verify). Dummy keys (1x…AA / 2x…AA) remain valid
      // when you want captcha on in dev/e2e.
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
    })
    .superRefine((data, ctx) => {
      const hasSite = Boolean(data.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
      const hasSecret = Boolean(data.TURNSTILE_SECRET_KEY);
      if (isProd && hasSite !== hasSecret) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Turnstile must be fully configured or fully omitted: set both NEXT_PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or neither.',
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

/** Local outbox / stub path — no real Resend key configured. */
export function isResendConfigured(): boolean {
  return isConfiguredSecret(env.RESEND_API_KEY);
}

/** Both Turnstile keys present — captcha UI + server verify are on. */
export function isTurnstileEnabled(): boolean {
  return Boolean(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() && env.TURNSTILE_SECRET_KEY?.trim());
}

/**
 * Whether magic-link emails may be written to a local outbox.
 * Always on in test, when RESEND_API_KEY=test, or outside production.
 * Production with no real Resend key stays fail-closed unless
 * ALLOW_LOCAL_OUTBOX is explicitly enabled.
 */
export function allowLocalMailOutbox(): boolean {
  if (env.NODE_ENV === 'test') return true;
  if (env.RESEND_API_KEY === 'test') return true;
  if (env.NODE_ENV !== 'production') return true;
  return env.ALLOW_LOCAL_OUTBOX === true;
}
