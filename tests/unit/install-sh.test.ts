import { execFileSync, spawnSync } from 'node:child_process';
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

  it('writes a password-mode .env with a local-outbox invite path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv(),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('MAIL_TRANSPORT=outbox');
      expect(result.stderr).toContain('ALLOW_LOCAL_OUTBOX=1');
      expect(result.stderr).toContain('mailbox proof');
      const dest = path.join(dir, '.env');
      const envFile = fs.readFileSync(dest, 'utf8');
      expect(envFile).toContain('AUTH_MODE=password');
      expect(envFile).toContain('MAIL_TRANSPORT=outbox');
      expect(envFile).toContain('ALLOW_LOCAL_OUTBOX=1');
      expect(envFile).toContain('SITE_URL=https://examify.example.com');
      expect(envFile).toContain('SETUP_BOOTSTRAP_SECRET=install-test-setup-secret');
      expect(envFile).not.toContain('RESEND_API_KEY=');
      expect(envFile).not.toContain('SMTP_HOST=');
      expect(envFile).not.toContain('OPENAI_API_KEY=');
      expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps SMTP mail when password-mode already has a delivery path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({
          MAIL_TRANSPORT: 'smtp',
          SMTP_HOST: 'smtp.example.com',
          SMTP_FROM: 'Examify <you@example.com>',
        }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('Enabling MAIL_TRANSPORT=outbox');
      const envFile = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      expect(envFile).toContain('AUTH_MODE=password');
      expect(envFile).toContain('MAIL_TRANSPORT=smtp');
      expect(envFile).toContain('SMTP_HOST=smtp.example.com');
      expect(envFile).not.toContain('ALLOW_LOCAL_OUTBOX=');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an already-good password .env without claiming to enable an outbox', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      const existing = [
        'KEEP_ME=1',
        'AUTH_MODE=password',
        'MAIL_TRANSPORT=outbox',
        'ALLOW_LOCAL_OUTBOX=1',
        '',
      ].join('\n');
      fs.writeFileSync(dest, existing, { mode: 0o600 });
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'password' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('Enabling MAIL_TRANSPORT=outbox');
      expect(result.stderr).not.toContain('did not enable an outbox');
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a kept password .env that has no invite mail path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      const existing = ['KEEP_ME=1', 'AUTH_MODE=password', 'MAIL_TRANSPORT=auto', ''].join('\n');
      fs.writeFileSync(dest, existing, { mode: 0o600 });
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'password' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Keeping existing .env');
      expect(result.stderr).toContain('did not enable an outbox');
      expect(result.stderr).not.toContain('Enabling MAIL_TRANSPORT=outbox');
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
      expect(fs.readFileSync(dest, 'utf8')).not.toContain('ALLOW_LOCAL_OUTBOX=');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints --help without reading $0 (curl | bash -s -- --help)', () => {
    const script = fs.readFileSync(SCRIPT);
    const result = spawnSync('bash', ['-s', '--', '--help'], {
      input: script,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Examify installer');
    expect(result.stdout).toContain('bash -s -- --help');
    expect(result.stdout).toContain('pdftoppm');
    expect(result.stderr).not.toMatch(/sed:/);
    expect(result.stdout).not.toMatch(/sed:/);
  });

  it('prints --help when invoked as ./install.sh --help', () => {
    const result = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--write-env-only');
    expect(result.stdout).toContain('mailbox proof');
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

  it('does not force an outbox for magic-link when mail is unset', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      execFileSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'magic-link' }),
        stdio: 'pipe',
      });
      const envFile = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      expect(envFile).toContain('AUTH_MODE=magic-link');
      expect(envFile).toContain('MAIL_TRANSPORT=auto');
      expect(envFile).not.toContain('ALLOW_LOCAL_OUTBOX=');
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
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'password' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('Enabling MAIL_TRANSPORT=outbox');
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
