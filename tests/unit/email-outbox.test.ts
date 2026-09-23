import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setDataDirForTests } from '@/lib/data-dir';
import { sendEmail } from '@/lib/email';

const ENV_KEYS = ['MAIL_OUTBOX_DIR', 'NODE_ENV', 'RESEND_API_KEY'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const scratch: string[] = [];

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else Reflect.set(process.env, key, value);
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function outboxFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
}

afterEach(() => {
  for (const key of ENV_KEYS) setEnv(key, originalEnv[key]);
  setDataDirForTests(null);
  for (const item of scratch.splice(0)) {
    fs.rmSync(item, { recursive: true, force: true });
  }
});

describe('sendEmail local outbox', () => {
  it('creates the outbox as 0700 and each message as 0600', async () => {
    const dest = tempDir('outbox-mode-');
    setEnv('MAIL_OUTBOX_DIR', dest);
    const result = await sendEmail({ to: 'a@example.com', subject: 's', html: '<p>hi</p>' });
    expect(result.ok).toBe(true);
    expect(fs.statSync(dest).mode & 0o777).toBe(0o700);
    const files = outboxFiles(dest);
    expect(files).toHaveLength(1);
    expect(fs.statSync(path.join(dest, files[0]!)).mode & 0o777).toBe(0o600);
  });

  it('returns SendResult failure when the outbox cannot be written', async () => {
    const blocker = path.join(tempDir('outbox-blocker-'), 'not-a-dir');
    fs.writeFileSync(blocker, 'not-a-dir');
    setEnv('MAIL_OUTBOX_DIR', blocker);
    const result = await sendEmail({ to: 'a@example.com', subject: 's', html: '<p>hi</p>' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it('defaults to <data folder>/outbox when MAIL_OUTBOX_DIR is unset', async () => {
    const dataDir = tempDir('outbox-data-');
    setDataDirForTests(dataDir);
    setEnv('MAIL_OUTBOX_DIR', undefined);
    setEnv('RESEND_API_KEY', undefined);
    setEnv('NODE_ENV', 'development');
    const result = await sendEmail({ to: 'a@example.com', subject: 's', html: '<p>hi</p>' });
    expect(result.ok).toBe(true);
    expect(outboxFiles(path.join(dataDir, 'outbox'))).toHaveLength(1);
  });

  it('never routes a production RESEND_API_KEY=test outbox into the checkout', async () => {
    const dataDir = tempDir('outbox-prod-');
    setDataDirForTests(dataDir);
    const checkoutOutbox = path.join(process.cwd(), 'tests', '.tmp', 'outbox');
    const before = outboxFiles(checkoutOutbox).length;
    setEnv('MAIL_OUTBOX_DIR', undefined);
    setEnv('RESEND_API_KEY', 'test');
    setEnv('NODE_ENV', 'production');
    const result = await sendEmail({ to: 'a@example.com', subject: 's', html: '<p>hi</p>' });
    setEnv('NODE_ENV', originalEnv.NODE_ENV);
    expect(result.ok).toBe(true);
    expect(outboxFiles(path.join(dataDir, 'outbox'))).toHaveLength(1);
    expect(outboxFiles(checkoutOutbox)).toHaveLength(before);
  });
});
