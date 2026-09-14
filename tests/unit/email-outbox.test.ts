import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sendEmail } from '@/lib/email';
import { env } from '@/lib/env';

const originalOutbox = env.MAIL_OUTBOX_DIR;
const scratch: string[] = [];

afterEach(() => {
  (env as { MAIL_OUTBOX_DIR?: string }).MAIL_OUTBOX_DIR = originalOutbox;
  for (const item of scratch.splice(0)) {
    fs.rmSync(item, { recursive: true, force: true });
  }
});

describe('sendEmail local outbox', () => {
  it('creates the outbox as 0700 and each message as 0600', async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-mode-'));
    scratch.push(dest);
    (env as { MAIL_OUTBOX_DIR?: string }).MAIL_OUTBOX_DIR = dest;
    const result = await sendEmail({ to: 'a@example.com', subject: 's', html: '<p>hi</p>' });
    expect(result.ok).toBe(true);
    expect(fs.statSync(dest).mode & 0o777).toBe(0o700);
    const files = fs.readdirSync(dest).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(fs.statSync(path.join(dest, files[0]!)).mode & 0o777).toBe(0o600);
  });

  it('returns SendResult failure when the outbox cannot be written', async () => {
    const blocker = path.join(os.tmpdir(), `outbox-blocker-${process.pid}-${Date.now()}`);
    fs.writeFileSync(blocker, 'not-a-dir');
    scratch.push(blocker);
    (env as { MAIL_OUTBOX_DIR?: string }).MAIL_OUTBOX_DIR = blocker;
    const result = await sendEmail({ to: 'a@example.com', subject: 's', html: '<p>hi</p>' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});
