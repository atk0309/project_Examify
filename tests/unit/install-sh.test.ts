import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.join(process.cwd(), 'install.sh');

describe('install.sh', () => {
  it('is present and parses under bash -n', () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
    execFileSync('bash', ['-n', SCRIPT], { stdio: 'pipe' });
  });

  it('writes a password-mode .env in write-env-only mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      execFileSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: {
          ...process.env,
          EXAMIFY_NONINTERACTIVE: '1',
          SITE_URL: 'https://examify.example.com',
          AUTH_SECRET: 'install-test-auth-secret-must-be-32ch',
          SETUP_BOOTSTRAP_SECRET: 'install-test-setup-secret',
          AUTH_MODE: 'password',
          DATABASE_URL: 'file:./data/app.db',
          ANTHROPIC_API_KEY: 'test',
        },
        stdio: 'pipe',
      });
      const envFile = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      expect(envFile).toContain('AUTH_MODE=password');
      expect(envFile).toContain('SITE_URL=https://examify.example.com');
      expect(envFile).toContain('SETUP_BOOTSTRAP_SECRET=install-test-setup-secret');
      expect(envFile).not.toContain('RESEND_API_KEY=re_');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
