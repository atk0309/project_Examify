import { z } from 'zod';

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
const IS_BUILD = process.env.NEXT_PHASE === 'phase-production-build';
const IS_PROD = process.env.NODE_ENV === 'production' && !IS_BUILD;

// Dev/test defaults. Applied only when NODE_ENV !== 'production'. In
// production these vars must be set explicitly; boot fails closed otherwise.
const dev = <T extends string>(value: T): T | undefined => (IS_PROD ? undefined : value);

/** Treat empty / whitespace-only strings as unset. */
function emptyToUndef(v: unknown): unknown {
  if (typeof v === 'string' && v.trim() === '') return undefined;
  return v;
}

const envSchema = z.object({
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
  // allowlist. A leftover FAMILIES value is read once by
  // `importLegacyFamiliesIfNeeded()` when the DB has no households yet
  // (existing Railway deploys); it is not validated at boot and is not
  // required for new installs.

  // Resend: optional. Unset or the `test` sentinel writes magic-link emails
  // to a local outbox instead of sending (dev/test, and a self-hosted box
  // that has not configured email yet). A missing key no longer fails boot —
  // the install wizard will later let hosts pick an auth/email mode.
  // TODO(multi-auth): passkeys / password / SMTP picker plug in alongside
  // this magic-link path; do not hard-require Resend when adding them.
  RESEND_API_KEY: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  RESEND_FROM: z.preprocess(emptyToUndef, z.string().min(1).optional()),

  // Anthropic key for free-text grading. The `test` sentinel (dev/test default)
  // routes the grader to a deterministic full-score stub — no network — exactly
  // like the Resend outbox stub above. A missing key in production fails closed
  // so an exam never silently scores every free-text answer as full marks.
  ANTHROPIC_API_KEY: z.preprocess((v) => v ?? dev('test'), z.string().min(1)),

  // Turnstile is optional. Both site + secret must be set to enable captcha;
  // unset/empty skips the widget and server verification so sign-in still
  // works. Dummy keys (1x…AA / 2x…AA) remain valid when you want captcha on
  // in dev/e2e. There is no production default — omit both to leave it off.
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  TURNSTILE_SECRET_KEY: z.preprocess(emptyToUndef, z.string().min(1).optional()),

  // Analytics is opt-in; absent value means no script renders.
  PLAUSIBLE_DOMAIN: z.string().optional(),
  PLAUSIBLE_SRC: z.string().optional(),

  // Sign-in rate-limit knob. A single per-IP bucket for every magic-link
  // request — see the no-enumeration note in src/actions/requestMagicLink.ts.
  // Defaults are reasonable; overrides are dev/ops choices.
  RATE_LIMIT_SIGNIN_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_SIGNIN_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(
    `Invalid environment variables (NODE_ENV=${process.env.NODE_ENV ?? 'unset'}):\n${issues}`,
  );
  throw new Error('Invalid environment variables');
}

export const env: Env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Local outbox / stub path — no real Resend key configured. */
export function isResendConfigured(): boolean {
  const key = env.RESEND_API_KEY?.trim();
  return Boolean(key && key !== 'test');
}

/** Both Turnstile keys present — captcha UI + server verify are on. */
export function isTurnstileEnabled(): boolean {
  return Boolean(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() && env.TURNSTILE_SECRET_KEY?.trim());
}
