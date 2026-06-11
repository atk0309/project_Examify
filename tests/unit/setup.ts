import fs from 'node:fs';
import path from 'node:path';

const TMP_ROOT = path.join(process.cwd(), 'tests', '.tmp');
const UNIT_DB = path.join(TMP_ROOT, 'unit.db');

Reflect.set(process.env, 'NODE_ENV', 'test');
if (!process.env.DATABASE_URL) Reflect.set(process.env, 'DATABASE_URL', `file:${UNIT_DB}`);
if (!process.env.AUTH_SECRET)
  Reflect.set(process.env, 'AUTH_SECRET', 'unit-test-secret-must-be-at-least-32-chars-long');
// Use a non-dummy secret by default so the Turnstile fetch path is exercised
// in tests; tests that want to verify the dummy-key shortcut override env
// at runtime.
if (!process.env.TURNSTILE_SECRET_KEY)
  Reflect.set(process.env, 'TURNSTILE_SECRET_KEY', 'unit-test-secret-not-a-cloudflare-dummy-12');

if (fs.existsSync(UNIT_DB)) fs.unlinkSync(UNIT_DB);
fs.mkdirSync(TMP_ROOT, { recursive: true });
