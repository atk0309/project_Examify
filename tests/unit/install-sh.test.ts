import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.join(process.cwd(), 'install.sh');

function installEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    EXAMIFY_NONINTERACTIVE: '1',
    SITE_URL: 'https://examify.example.com',
    AUTH_SECRET: 'install-test-auth-secret-must-be-32ch',
    SETUP_BOOTSTRAP_SECRET: 'install-test-setup-secret',
    AUTH_MODE: 'password',
    DATABASE_URL: 'file:./data/app.db',
    ANTHROPIC_API_KEY: 'test',
    ...overrides,
  };
}

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
        env: installEnv(),
        stdio: 'pipe',
      });
      const dest = path.join(dir, '.env');
      const envFile = fs.readFileSync(dest, 'utf8');
      expect(envFile).toContain('AUTH_MODE=password');
      expect(envFile).toContain('SITE_URL=https://examify.example.com');
      expect(envFile).toContain('SETUP_BOOTSTRAP_SECRET=install-test-setup-secret');
      expect(envFile).not.toContain('RESEND_API_KEY=');
      expect(envFile).not.toContain('SMTP_HOST=');
      expect(envFile).not.toContain('ALLOW_LOCAL_OUTBOX=');
      expect(envFile).not.toContain('OPENAI_API_KEY=');
      expect(envFile).toContain('ANTHROPIC_API_KEY=test');
      expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes .env at the examify repo root when invoked from a subdirectory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-root-'));
    const nested = path.join(root, 'src', 'lib');
    try {
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'project-examify' }),
      );
      fs.mkdirSync(nested, { recursive: true });
      const secret = 'sk-install-subdir-openai-key';
      execFileSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: nested,
        env: installEnv({ OPENAI_API_KEY: secret }),
        stdio: 'pipe',
      });
      expect(fs.existsSync(path.join(root, '.env'))).toBe(true);
      expect(fs.existsSync(path.join(nested, '.env'))).toBe(false);
      expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toContain(
        `OPENAI_API_KEY=${secret}`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes ANTHROPIC_API_KEY when provided instead of the test sentinel', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const secret = 'sk-install-test-anthropic-key';
      execFileSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ ANTHROPIC_API_KEY: secret }),
        stdio: 'pipe',
      });
      const envFile = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      expect(envFile).toContain(`ANTHROPIC_API_KEY=${secret}`);
      expect(envFile).not.toContain('ANTHROPIC_API_KEY=test');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes OPENAI_API_KEY when provided', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const secret = 'sk-install-test-openai-key';
      execFileSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ OPENAI_API_KEY: secret }),
        stdio: 'pipe',
      });
      const envFile = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      expect(envFile).toContain(`OPENAI_API_KEY=${secret}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an existing .env in non-interactive mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      fs.writeFileSync(dest, 'KEEP_ME=1\nAUTH_MODE=magic-link\n', { mode: 0o600 });
      execFileSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'password' }),
        stdio: 'pipe',
      });
      const envFile = fs.readFileSync(dest, 'utf8');
      expect(envFile).toContain('KEEP_ME=1');
      expect(envFile).toContain('AUTH_MODE=magic-link');
      expect(envFile).not.toContain('AUTH_MODE=password');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes secret values literally without expanding shell substitutions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const secret = 'install-test-$(whoami)-secret-32chars!!';
      execFileSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_SECRET: secret }),
        stdio: 'pipe',
      });
      const envFile = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      expect(envFile).toContain(`AUTH_SECRET=${secret}`);
      expect(envFile).not.toMatch(/AUTH_SECRET=install-test-[a-z0-9]+-secret-32chars!!/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
