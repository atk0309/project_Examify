import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ROOT = path.join(process.cwd(), 'tests', '.tmp');
const UNIT_DB = path.join(TMP_ROOT, 'unit.db');
// Per worker process, wiped before every test file. Set unconditionally: a
// developer's exported EXAMIFY_DATA_DIR must never point unit tests at a real
// family data folder (DB, uploads, generated keys).
const UNIT_DATA_DIR = path.join(TMP_ROOT, `unit-data-${process.pid}`);

Reflect.set(process.env, 'NODE_ENV', 'test');
Reflect.set(process.env, 'EXAMIFY_DATA_DIR', UNIT_DATA_DIR);
// Same for the database: never a developer's exported DATABASE_URL.
Reflect.set(process.env, 'DATABASE_URL', `file:${UNIT_DB}`);
if (!process.env.AUTH_SECRET)
  Reflect.set(process.env, 'AUTH_SECRET', 'unit-test-secret-must-be-at-least-32-chars-long');
// Turnstile stays off in unit tests unless a case sets TURNSTILE_ENABLED=1.
// Keys alone do not enable captcha (same rule as production / self-host).
if (!process.env.TURNSTILE_SECRET_KEY)
  Reflect.set(process.env, 'TURNSTILE_SECRET_KEY', 'unit-test-secret-not-a-cloudflare-dummy-12');
if (!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY)
  Reflect.set(process.env, 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
if (!process.env.RESEND_API_KEY) Reflect.set(process.env, 'RESEND_API_KEY', 'test');
if (!process.env.ANTHROPIC_API_KEY) Reflect.set(process.env, 'ANTHROPIC_API_KEY', 'test');
// Never a developer's own Claude Code / Codex: the wizard snapshot and marking
// status ask a found CLI whether it is signed in. Tests that need one point
// the binaries at tests/helpers/fake-agent-cli.ts. Their folders are pinned
// too (outside the checkout, which the app refuses, and never created), so a
// check against a fake never copies a real sign-in.
Reflect.set(process.env, 'EXAMIFY_CLAUDE_BIN', path.join(TMP_ROOT, 'no-agent-cli', 'claude'));
Reflect.set(process.env, 'EXAMIFY_CODEX_BIN', path.join(TMP_ROOT, 'no-agent-cli', 'codex'));
const NO_CLI_HOME = path.join(os.tmpdir(), 'examify-unit-no-agent-cli-home');
Reflect.set(process.env, 'CLAUDE_CONFIG_DIR', path.join(NO_CLI_HOME, 'claude'));
Reflect.set(process.env, 'CODEX_HOME', path.join(NO_CLI_HOME, 'codex'));
// A headless sign-in token turns "signed out" into "unknown": never a developer's.
Reflect.deleteProperty(process.env, 'CLAUDE_CODE_OAUTH_TOKEN');
Reflect.deleteProperty(process.env, 'CODEX_API_KEY');
if (!process.env.MAIL_OUTBOX_DIR) {
  Reflect.set(process.env, 'MAIL_OUTBOX_DIR', path.join(TMP_ROOT, `outbox-unit-${process.pid}`));
}

if (fs.existsSync(UNIT_DB)) fs.unlinkSync(UNIT_DB);
fs.rmSync(UNIT_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });
