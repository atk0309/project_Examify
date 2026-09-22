/**
 * Which Playwright config runs which spec. Each spec belongs to exactly one
 * suite, because each suite boots its own `next start` with a different
 * AUTH_MODE / seed:
 *
 *   - `playwright.config.ts`          seeded household, magic-link, captcha on
 *   - `playwright.fresh.config.ts`    empty DB (first-run bootstrap), captcha off
 *   - `playwright.password.config.ts` seeded household, AUTH_MODE=password
 *
 * The default config ignores both patterns below; the other two match only
 * their own. `tests/unit/e2e-suites.test.ts` asserts the split.
 */
export const FRESH_SPEC = /fresh\.(spec|test)\.ts/;

/** Anchored to the basename so e.g. `forgot-password.spec.ts` stays seeded. */
export const PASSWORD_SPEC = /(?:^|[\\/])password\.(spec|test)\.ts$/;
