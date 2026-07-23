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
const IS_BUILD = process.env.NEXT_PHASE === 'phase-production-build';
const IS_PROD = process.env.NODE_ENV === 'production' && !IS_BUILD;

// Dev/test defaults. Applied only when NODE_ENV !== 'production'. In
// production these vars must be set explicitly; boot fails closed otherwise.
const dev = <T extends string>(value: T): T | undefined => (IS_PROD ? undefined : value);

// Dev/test default for FAMILIES: one student paired with one parent, mirroring
// the old `student@example.com` / `parent@example.com` defaults so local dev and
// the e2e dev-defaults keep working out of the box.
const DEFAULT_FAMILIES_JSON = '[{"child":"student@example.com","parents":["parent@example.com"]}]';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Public app URL supplied at runtime. Drives absolute URLs in magic-link
  // sign-in emails.
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

  // Families — the credential store for Examify, same runtime-config pattern as
  // SITE_URL. A single JSON array; each entry is `{ child, parents }`. It is the
  // single source of truth for (1) the student sign-in allowlist (every `child`),
  // (2) the parent sign-in allowlist (every `parents[]` entry), and (3) which
  // child a parent may see on their dashboard (the `child` of their own family).
  // There is no DB row, no admin — the env IS the allowlist + the privacy
  // boundary. See `src/lib/families.ts`.
  //
  // Parsed to a typed `Family[]` at boot: empty/unset ⇒ `[]` (fail closed —
  // nobody can sign in); malformed JSON or an invalid email fails boot with a
  // readable error (and fails the platform healthcheck). The dev default below pairs
  // one student with one parent so `pnpm dev` and the e2e dev-defaults work.
  FAMILIES: z.preprocess(
    (v) => v ?? dev(DEFAULT_FAMILIES_JSON),
    z
      .string()
      .default('[]')
      .transform((raw, ctx) => {
        const result = parseFamilies(raw);
        if (!result.ok) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
          return z.NEVER;
        }
        return result.families;
      }),
  ),

  // Resend keys: a missing key in production silently routes emails to a
  // tests/.tmp/outbox file, which means subscribers never receive their
  // magic links. Fail closed instead.
  RESEND_API_KEY: z.preprocess((v) => v ?? dev('test'), z.string().min(1)),
  RESEND_FROM: z.preprocess((v) => v ?? dev('Examify <onboarding@resend.dev>'), z.string().min(1)),

  // Anthropic key for free-text grading. The `test` sentinel (dev/test default)
  // routes the grader to a deterministic full-score stub — no network — exactly
  // like the Resend outbox stub above. A missing key in production fails closed
  // so an exam never silently scores every free-text answer as full marks.
  ANTHROPIC_API_KEY: z.preprocess((v) => v ?? dev('test'), z.string().min(1)),

  // Turnstile: the always-pass dummy keys are convenient for dev/tests, but
  // a production deploy that lands on the dummy secret effectively disables
  // captcha checking on every form.
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.preprocess(
    (v) => v ?? dev('1x00000000000000000000AA'),
    z.string().min(1),
  ),
  TURNSTILE_SECRET_KEY: z.preprocess(
    (v) => v ?? dev('1x0000000000000000000000000000000AA'),
    z.string().min(1),
  ),

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
