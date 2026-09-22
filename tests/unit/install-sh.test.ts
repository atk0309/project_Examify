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
      expect(envFile).not.toContain('TURNSTILE_ENABLED=');
      expect(envFile).not.toContain('NEXT_PUBLIC_TURNSTILE_SITE_KEY=');
      expect(envFile).toContain('ANTHROPIC_API_KEY=test');
      expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not enable Turnstile from keys alone (opt-in flag required)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({
          NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
          TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      const envFile = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      expect(envFile).not.toContain('TURNSTILE_ENABLED=');
      expect(envFile).not.toContain('NEXT_PUBLIC_TURNSTILE_SITE_KEY=');
      expect(envFile).not.toContain('TURNSTILE_SECRET_KEY=');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes Turnstile only when TURNSTILE_ENABLED=1 and both keys are set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({
          TURNSTILE_ENABLED: '1',
          NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
          TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      const envFile = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      expect(envFile).toContain('TURNSTILE_ENABLED=1');
      expect(envFile).toContain('NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA');
      expect(envFile).toContain('TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts TURNSTILE_ENABLED=true (same as parseEnv) and writes canonical =1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({
          TURNSTILE_ENABLED: 'true',
          NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
          TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      const envFile = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      expect(envFile).toContain('TURNSTILE_ENABLED=1');
      expect(envFile).not.toContain('TURNSTILE_ENABLED=true');
      expect(envFile).toContain('NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA');
      expect(envFile).toContain('TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses TURNSTILE_ENABLED=1 without both keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({
          TURNSTILE_ENABLED: '1',
          NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
        }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('TURNSTILE_ENABLED=1 requires both');
      expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses TURNSTILE_ENABLED=true without both keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({
          TURNSTILE_ENABLED: 'true',
          TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('TURNSTILE_ENABLED=1 requires both');
      expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
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

  it('prompts for ANTHROPIC_API_KEY as an OpenAI twin (secret, same .env store)', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('ANTHROPIC_API_KEY for /onboarding Cloud (Anthropic) generate.');
    expect(script).toContain(
      'Same .env store as the wizard. Leave blank to keep the test sentinel (you can set it later).',
    );
    expect(script).toContain('prompt ANTHROPIC_API_KEY "Anthropic API key" "" secret');
    expect(script).toContain('Optional: OPENAI_API_KEY for /onboarding Cloud (OpenAI) generate.');
    expect(script).toContain('prompt OPENAI_API_KEY "OpenAI API key" "" secret');
    expect(script).toContain('ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-test}"');
  });

  it('explains SITE_URL as the address family devices open before prompting', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');
    expect(script).toContain(
      'Public site URL: the address family devices open, e.g. https://exam.example.com',
    );
    expect(script).toContain('or http://192.168.1.20:3000. localhost only works on this machine.');
  });

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1:3000/',
    'https://LOCALHOST:8443',
    'http://[::1]:3000',
  ])('warns that invite links only open on this machine for SITE_URL=%s', (siteUrl) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ SITE_URL: siteUrl }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('invite links will only open on this machine');
      expect(result.stderr).not.toContain('traffic is unencrypted');
      expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain(`SITE_URL=${siteUrl}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns about localhost when SITE_URL falls back to the installer default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const env = installEnv();
      delete env.SITE_URL;
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        'Warning: SITE_URL uses localhost, so invite links will only open on this machine.',
      );
      expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain(
        'SITE_URL=http://localhost:3000',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('notes that plain http on a LAN address is unencrypted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ SITE_URL: 'http://192.168.1.20:3000' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        'Note: SITE_URL is plain http, so traffic is unencrypted; use HTTPS (a reverse proxy) beyond your home network.',
      );
      expect(result.stderr).not.toContain('only open on this machine');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints no SITE_URL warning for an https public origin', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ SITE_URL: 'https://exam.example.com' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('SITE_URL uses');
      expect(result.stderr).not.toContain('SITE_URL is plain http');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips the SITE_URL note when a non-interactive run keeps an existing .env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      fs.writeFileSync(
        path.join(dir, '.env'),
        'SITE_URL=https://exam.example.com\nAUTH_MODE=magic-link\n',
        { mode: 0o600 },
      );
      const env = installEnv({ SITE_URL: 'http://localhost:3000' });
      delete env.AUTH_MODE;
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Keeping existing .env');
      expect(result.stderr).not.toContain('SITE_URL uses');
      expect(result.stderr).not.toContain('SITE_URL is plain http');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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
      const env = installEnv({ AUTH_MODE: 'password' });
      delete env.AUTH_MODE;
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env,
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

  it('refuses a kept password .env when ALLOW_LOCAL_OUTBOX is set but transport is smtp without SMTP', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      const existing = [
        'AUTH_MODE=password',
        'MAIL_TRANSPORT=smtp',
        'ALLOW_LOCAL_OUTBOX=1',
        '',
      ].join('\n');
      fs.writeFileSync(dest, existing, { mode: 0o600 });
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'password' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('did not enable an outbox');
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses mail, not a .env-only AUTH_MODE lie, when host matches .env.local password', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'AUTH_MODE=magic-link\nMAIL_TRANSPORT=auto\n', {
        mode: 0o600,
      });
      fs.writeFileSync(path.join(dir, '.env.local'), 'AUTH_MODE=password\nMAIL_TRANSPORT=auto\n', {
        mode: 0o600,
      });
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'password' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('on-disk config is AUTH_MODE=password');
      expect(result.stderr).toContain('did not enable an outbox');
      expect(result.stderr).not.toContain('Host AUTH_MODE=');
      expect(result.stderr).not.toContain('the kept file is AUTH_MODE=magic-link');
      expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain('AUTH_MODE=magic-link');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a kept .env when .env.local selects password without a mail path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'AUTH_MODE=magic-link\nMAIL_TRANSPORT=auto\n', {
        mode: 0o600,
      });
      fs.writeFileSync(path.join(dir, '.env.local'), 'AUTH_MODE=password\nMAIL_TRANSPORT=auto\n', {
        mode: 0o600,
      });
      const env = installEnv();
      delete env.AUTH_MODE;
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('did not enable an outbox');
      expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain('AUTH_MODE=magic-link');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats omitted AUTH_MODE on a kept .env as magic-link (runtime default), not password', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      fs.writeFileSync(dest, 'KEEP_ME=1\nMAIL_TRANSPORT=auto\n', { mode: 0o600 });
      const env = installEnv();
      delete env.AUTH_MODE;
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(fs.readFileSync(dest, 'utf8')).toBe('KEEP_ME=1\nMAIL_TRANSPORT=auto\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses auto+SMTP_HOST without SMTP_FROM even when an outbox is allowed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      const existing = [
        'AUTH_MODE=password',
        'MAIL_TRANSPORT=auto',
        'SMTP_HOST=smtp.example.com',
        'ALLOW_LOCAL_OUTBOX=1',
        '',
      ].join('\n');
      fs.writeFileSync(dest, existing, { mode: 0o600 });
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'password' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('did not enable an outbox');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a kept broken password .env even when the host has ALLOW_LOCAL_OUTBOX=1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      const existing = ['KEEP_ME=1', 'AUTH_MODE=password', 'MAIL_TRANSPORT=auto', ''].join('\n');
      fs.writeFileSync(dest, existing, { mode: 0o600 });
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'password', ALLOW_LOCAL_OUTBOX: '1' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Keeping existing .env');
      expect(result.stderr).toContain('AUTH_MODE=password');
      expect(result.stderr).toContain('did not enable an outbox');
      expect(result.stderr).not.toContain('Enabling MAIL_TRANSPORT=outbox');
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
      expect(fs.readFileSync(dest, 'utf8')).not.toContain('ALLOW_LOCAL_OUTBOX=');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a host AUTH_MODE that differs from the kept .env and names the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      const existing = 'KEEP_ME=1\nAUTH_MODE=magic-link\n';
      fs.writeFileSync(dest, existing, { mode: 0o600 });
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'password' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Host AUTH_MODE=password');
      expect(result.stderr).toContain('the kept file is AUTH_MODE=magic-link');
      expect(result.stderr).not.toContain('the kept file is AUTH_MODE=password');
      expect(result.stderr).not.toContain('Enabling MAIL_TRANSPORT=outbox');
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a host AUTH_MODE that differs from effective on-disk mode when .env.local wins', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      const existing = 'KEEP_ME=1\nAUTH_MODE=magic-link\n';
      fs.writeFileSync(dest, existing, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, '.env.local'), 'AUTH_MODE=password\n', { mode: 0o600 });
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'magic-link' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Host AUTH_MODE=magic-link');
      expect(result.stderr).toContain('on-disk AUTH_MODE=password');
      expect(result.stderr).toContain('.env.local overrides .env AUTH_MODE=magic-link');
      expect(result.stderr).not.toContain('the kept file is AUTH_MODE=magic-link');
      expect(result.stderr).not.toContain('the kept file is AUTH_MODE=password');
      expect(result.stderr).not.toContain('Enabling MAIL_TRANSPORT=outbox');
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses host password when .env.local overrides a password .env to magic-link', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      const existing = [
        'AUTH_MODE=password',
        'MAIL_TRANSPORT=outbox',
        'ALLOW_LOCAL_OUTBOX=1',
        '',
      ].join('\n');
      fs.writeFileSync(dest, existing, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, '.env.local'), 'AUTH_MODE=magic-link\n', { mode: 0o600 });
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'password' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Host AUTH_MODE=password');
      expect(result.stderr).toContain('on-disk AUTH_MODE=magic-link');
      expect(result.stderr).toContain('.env.local overrides .env AUTH_MODE=password');
      expect(result.stderr).not.toContain('the kept file is AUTH_MODE=password');
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets an empty .env.local ALLOW_LOCAL_OUTBOX shadow a kept password outbox', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      const existing = [
        'AUTH_MODE=password',
        'MAIL_TRANSPORT=outbox',
        'ALLOW_LOCAL_OUTBOX=1',
        '',
      ].join('\n');
      fs.writeFileSync(dest, existing, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, '.env.local'), 'ALLOW_LOCAL_OUTBOX=\n', { mode: 0o600 });
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'password' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('did not enable an outbox');
      expect(result.stderr).not.toContain('Enabling MAIL_TRANSPORT=outbox');
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats an empty .env.local AUTH_MODE as a magic-link override of a password .env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      const existing = [
        'AUTH_MODE=password',
        'MAIL_TRANSPORT=outbox',
        'ALLOW_LOCAL_OUTBOX=1',
        '',
      ].join('\n');
      fs.writeFileSync(dest, existing, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, '.env.local'), 'AUTH_MODE=\n', { mode: 0o600 });
      const keep = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'magic-link' }),
        encoding: 'utf8',
      });
      expect(keep.status).toBe(0);
      expect(keep.stderr).not.toContain('Host AUTH_MODE=');
      expect(keep.stderr).not.toContain('did not enable an outbox');
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);

      const conflict = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'password' }),
        encoding: 'utf8',
      });
      expect(conflict.status).toBe(1);
      expect(conflict.stderr).toContain('Host AUTH_MODE=password');
      expect(conflict.stderr).toContain('on-disk AUTH_MODE=magic-link');
      expect(conflict.stderr).toContain('.env.local overrides .env AUTH_MODE=password');
      expect(conflict.stderr).not.toContain('the kept file is AUTH_MODE=password');
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not treat host AUTH_MODE as a conflict when it matches .env.local over .env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      const existing = [
        'AUTH_MODE=password',
        'MAIL_TRANSPORT=outbox',
        'ALLOW_LOCAL_OUTBOX=1',
        '',
      ].join('\n');
      fs.writeFileSync(dest, existing, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, '.env.local'), 'AUTH_MODE=magic-link\n', { mode: 0o600 });
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'magic-link' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('Host AUTH_MODE=');
      expect(result.stderr).not.toContain('did not enable an outbox');
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not treat on-disk RESEND_API_KEY=test as a mail path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      const existing = [
        'AUTH_MODE=password',
        'MAIL_TRANSPORT=auto',
        'RESEND_API_KEY=test',
        'RESEND_FROM=Examify <you@example.com>',
        '',
      ].join('\n');
      fs.writeFileSync(dest, existing, { mode: 0o600 });
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv({ AUTH_MODE: 'password' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('did not enable an outbox');
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a good password outbox .env byte-identical even if the host also sets ALLOW_LOCAL_OUTBOX', () => {
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
        env: installEnv({ AUTH_MODE: 'password', ALLOW_LOCAL_OUTBOX: '1' }),
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

  it('keeps a password .env whose AUTH_MODE line has an unquoted comment', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const dest = path.join(dir, '.env');
      const existing = [
        'AUTH_MODE=password # dogfood',
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
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
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
