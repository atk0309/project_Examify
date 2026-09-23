import {
  execFileSync,
  spawn,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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

/**
 * Runs the installer the way a person would (no EXAMIFY_NONINTERACTIVE), but
 * detached into a new session so there is no controlling terminal: each
 * prompt prints to stdout and reads its answer from `input` (empty: every
 * prompt takes its default), and nothing blocks on a tty.
 */
function interactiveWriteEnvOnly(dir: string, input = '') {
  // spawnSync honours `detached` (setsid: new session, no controlling tty)
  // even though @types/node only declares it on spawn().
  const options = {
    cwd: dir,
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    },
    input,
    encoding: 'utf8',
    detached: true,
    timeout: 30_000,
  } as SpawnSyncOptionsWithStringEncoding;
  return spawnSync('bash', [SCRIPT, '--write-env-only'], options);
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

  it('an interactive run shows the honest banner, SITE_URL help and key copy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const result = interactiveWriteEnvOnly(dir);
      expect(result.status).toBe(0);
      const out = result.stdout;
      // Banner: accounts and progress stay local; AI features send data out.
      expect(out).toContain('Invite-only; accounts and progress stay on this server.');
      expect(out).toContain(
        'AI marking and cloud generate send answer text or study PDFs to the provider you choose.',
      );
      expect(out).not.toContain('data stays on this box');
      // SITE_URL is explained before the prompt, and localhost is flagged.
      expect(out).toContain(
        'Public site URL: the address family devices open, e.g. https://exam.example.com',
      );
      expect(out).toContain('or http://192.168.1.20:3000. localhost only works on this machine.');
      expect(result.stderr).toContain(
        'Warning: SITE_URL uses localhost, so invite links will only open on this machine.',
      );
      // Key prompts say what is sent and what blank means; no jargon.
      expect(out).toContain(
        'Optional: ANTHROPIC_API_KEY marks free-text answers by sending each answer, its question,',
      );
      expect(out).toContain(
        'Leave blank to skip: free-text answers are saved but not marked (they count as not correct).',
      );
      expect(out).toContain('Anthropic API key: ');
      expect(out).toContain(
        "That generate sends the subject's study files (PDF pages, notes) to OpenAI.",
      );
      expect(out).toContain('OpenAI API key: ');
      expect(out).not.toContain('test sentinel');
      // A blank Anthropic answer keeps the placeholder (production treats it as no key).
      const written = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      expect(written).toContain('ANTHROPIC_API_KEY=test\n');
      expect(written).not.toContain('OPENAI_API_KEY=');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an interactive rerun that keeps .env does not warn about the unused SITE_URL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      fs.writeFileSync(
        path.join(dir, '.env'),
        'SITE_URL=https://exam.example.com\nAUTH_MODE=magic-link\n',
        { mode: 0o600 },
      );
      const result = interactiveWriteEnvOnly(dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Keeping existing .env');
      expect(result.stderr).not.toContain('SITE_URL uses');
      expect(result.stderr).not.toContain('SITE_URL is plain http');
      expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain(
        'SITE_URL=https://exam.example.com',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-interactive --write-env-only run stays quiet (no banner)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-install-'));
    try {
      const result = spawnSync('bash', [SCRIPT, '--write-env-only'], {
        cwd: dir,
        env: installEnv(),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('Examify installer');
      expect(result.stdout).not.toContain('Public site URL:');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

/** A realpath'd temp dir, so printed paths compare equal where /tmp is a symlink. */
function tmpDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeEnvOnly(cwd: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  return spawnSync('bash', [SCRIPT, '--write-env-only', ...args], { cwd, env, encoding: 'utf8' });
}

/** installEnv without DATABASE_URL (the installer writes it only when the host sets one). */
function dataEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env = installEnv(overrides);
  if (!('DATABASE_URL' in overrides)) delete env.DATABASE_URL;
  return env;
}

describe('install.sh family data folder (.env)', () => {
  it('writes EXAMIFY_DATA_DIR=./data and no DATABASE_URL unless the host sets one', () => {
    const dir = tmpDir('examify-install-');
    try {
      const result = writeEnvOnly(dir, dataEnv());
      expect(result.status).toBe(0);
      const envFile = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      expect(envFile).toContain('EXAMIFY_DATA_DIR=./data\n');
      expect(envFile).not.toContain('DATABASE_URL=');
      // The outbox copy names the data folder, not a fixed data/outbox.
      expect(result.stderr).toContain('./data/outbox');

      fs.rmSync(path.join(dir, '.env'));
      const withDb = writeEnvOnly(dir, dataEnv({ DATABASE_URL: 'file:./data/app.db' }));
      expect(withDb.status).toBe(0);
      const written = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      expect(written).toContain('EXAMIFY_DATA_DIR=./data\n');
      expect(written).toContain('DATABASE_URL=file:./data/app.db\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults the folder to a host DATABASE_URL folder outside the checkout', () => {
    const dir = tmpDir('examify-install-');
    const volume = tmpDir('examify-volume-');
    try {
      const url = `file:${volume}/app.db`;
      const result = writeEnvOnly(dir, dataEnv({ DATABASE_URL: url }));
      expect(result.status).toBe(0);
      const envFile = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      expect(envFile).toContain(`EXAMIFY_DATA_DIR=${volume}\n`);
      expect(envFile).toContain(`DATABASE_URL=${url}\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(volume, { recursive: true, force: true });
    }
  });

  it('expands a leading ~ from --data-dir or a host EXAMIFY_DATA_DIR before writing', () => {
    const dir = tmpDir('examify-install-');
    const home = tmpDir('examify-home-');
    try {
      const flag = writeEnvOnly(dir, dataEnv({ HOME: home }), ['--data-dir', '~/examify-data']);
      expect(flag.status).toBe(0);
      expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain(
        `EXAMIFY_DATA_DIR=${home}/examify-data\n`,
      );

      fs.rmSync(path.join(dir, '.env'));
      const host = writeEnvOnly(dir, dataEnv({ HOME: home, EXAMIFY_DATA_DIR: '~/family' }));
      expect(host.status).toBe(0);
      expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain(
        `EXAMIFY_DATA_DIR=${home}/family\n`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ['a quote', '/srv/exam"ify', 'contains a quote'],
    ['an inline comment', '/srv/examify #data', 'reads as a comment'],
    ['a dollar sign', '/srv/$USER/examify', 'contains $'],
    ['~user', '~someone/examify', 'starts with ~'],
    ['a folder inside the checkout', './src/data', 'must be ./data'],
    ['the checkout itself', '.', 'cannot be the checkout'],
    ['a folder containing the checkout', '..', 'cannot be the checkout'],
  ])('refuses a data folder with %s and writes nothing', (_label, value, message) => {
    const dir = tmpDir('examify-install-');
    try {
      const result = writeEnvOnly(dir, dataEnv(), ['--data-dir', value]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['a database', 'app.db'],
    ['a WAL file', 'app.db-wal'],
    ['the marker', '.examify-data.json'],
    ['an outbox', 'outbox/'],
  ])('reuses a folder that already holds family data (%s)', (_label, entry) => {
    const dir = tmpDir('examify-install-');
    const data = tmpDir('examify-data-');
    try {
      if (entry.endsWith('/')) fs.mkdirSync(path.join(data, entry));
      else fs.writeFileSync(path.join(data, entry), '');
      const result = writeEnvOnly(dir, dataEnv({ EXAMIFY_DATA_DIR: data }));
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Found existing family data in ${data}; it will be reused.`);
      expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain(
        `EXAMIFY_DATA_DIR=${data}\n`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(data, { recursive: true, force: true });
    }
  });

  it('refuses a non-empty folder that is not an Examify data folder', () => {
    const dir = tmpDir('examify-install-');
    const data = tmpDir('examify-data-');
    try {
      fs.writeFileSync(path.join(data, 'holiday.jpg'), 'x');
      const result = writeEnvOnly(dir, dataEnv(), ['--data-dir', data]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('is not an Examify data folder');
      expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
      expect(fs.readdirSync(data)).toEqual(['holiday.jpg']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(data, { recursive: true, force: true });
    }
  });

  it('refuses to write a folder that .env.local would override', () => {
    const dir = tmpDir('examify-install-');
    try {
      fs.writeFileSync(path.join(dir, '.env.local'), 'EXAMIFY_DATA_DIR=/srv/elsewhere\n');
      const result = writeEnvOnly(dir, dataEnv());
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('.env.local overrides the .env this run writes');
      expect(result.stderr).toContain('/srv/elsewhere');
      expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a host EXAMIFY_DATA_DIR that differs from a kept .env and names both', () => {
    const dir = tmpDir('examify-install-');
    try {
      const dest = path.join(dir, '.env');
      const existing = 'AUTH_MODE=magic-link\nEXAMIFY_DATA_DIR=/srv/examify-data\n';
      fs.writeFileSync(dest, existing, { mode: 0o600 });
      const env = dataEnv({ EXAMIFY_DATA_DIR: '/srv/other-data' });
      delete env.AUTH_MODE;
      const result = writeEnvOnly(dir, env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Host EXAMIFY_DATA_DIR=/srv/other-data');
      expect(result.stderr).toContain(
        'the kept files use the family data folder /srv/examify-data (EXAMIFY_DATA_DIR in .env)',
      );
      expect(result.stderr).toContain('did not overwrite .env');
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);

      const flag = writeEnvOnly(dir, { ...env, EXAMIFY_DATA_DIR: undefined }, [
        '--data-dir',
        '/srv/third',
      ]);
      expect(flag.status).toBe(1);
      expect(flag.stderr).toContain('--data-dir /srv/third');
      expect(flag.stderr).toContain('/srv/examify-data');

      // The same folder spelled differently is not a conflict.
      const same = writeEnvOnly(dir, { ...env, EXAMIFY_DATA_DIR: '/srv/./examify-data/' });
      expect(same.status).toBe(0);
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('judges the kept data folder in Next order (.env.production.local > .env.local > .env)', () => {
    const dir = tmpDir('examify-install-');
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'AUTH_MODE=magic-link\nEXAMIFY_DATA_DIR=/srv/a\n');
      fs.writeFileSync(path.join(dir, '.env.local'), 'EXAMIFY_DATA_DIR=/srv/b\n');
      const env = dataEnv();
      delete env.AUTH_MODE;

      expect(writeEnvOnly(dir, { ...env, EXAMIFY_DATA_DIR: '/srv/b' }).status).toBe(0);
      const loses = writeEnvOnly(dir, { ...env, EXAMIFY_DATA_DIR: '/srv/a' });
      expect(loses.status).toBe(1);
      expect(loses.stderr).toContain('/srv/b (EXAMIFY_DATA_DIR in .env.local)');

      fs.writeFileSync(path.join(dir, '.env.production.local'), 'EXAMIFY_DATA_DIR=/srv/c\n');
      const prod = writeEnvOnly(dir, { ...env, EXAMIFY_DATA_DIR: '/srv/b' });
      expect(prod.status).toBe(1);
      expect(prod.stderr).toContain('/srv/c (EXAMIFY_DATA_DIR in .env.production.local)');

      // An empty assignment still wins: the app falls back to ./data.
      fs.writeFileSync(path.join(dir, '.env.production.local'), 'EXAMIFY_DATA_DIR=\n');
      const empty = writeEnvOnly(dir, { ...env, EXAMIFY_DATA_DIR: '/srv/b' });
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain(`${dir}/data (the default ./data)`);
      expect(writeEnvOnly(dir, { ...env, EXAMIFY_DATA_DIR: './data' }).status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a host DATABASE_URL that differs from the kept database', () => {
    const dir = tmpDir('examify-install-');
    try {
      const dest = path.join(dir, '.env');
      const existing = 'AUTH_MODE=magic-link\nDATABASE_URL=file:/srv/examify/app.db\n';
      fs.writeFileSync(dest, existing, { mode: 0o600 });
      const env = installEnv({ DATABASE_URL: 'file:./data/app.db' });
      delete env.AUTH_MODE;
      const result = writeEnvOnly(dir, env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Host DATABASE_URL=file:./data/app.db');
      expect(result.stderr).toContain(
        'the kept files use the database /srv/examify/app.db (DATABASE_URL in .env)',
      );
      expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a kept EXAMIFY_DATA_DIR the app would refuse, naming the file', () => {
    const dir = tmpDir('examify-install-');
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'AUTH_MODE=magic-link\n');
      fs.writeFileSync(path.join(dir, '.env.local'), 'EXAMIFY_DATA_DIR=~/examify\n');
      const env = dataEnv();
      delete env.AUTH_MODE;
      const result = writeEnvOnly(dir, env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('.env.local has EXAMIFY_DATA_DIR=~/examify');
      expect(result.stderr).toContain('starts with ~');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an interactive new install asks for the family data folder; a kept .env does not', () => {
    const dir = tmpDir('examify-install-');
    try {
      const fresh = interactiveWriteEnvOnly(dir);
      expect(fresh.status).toBe(0);
      expect(fresh.stdout).toContain(
        'Family data folder: the database, uploaded study PDFs, subjects, generated questions',
      );
      expect(fresh.stdout).toContain('re-clone it.');
      expect(fresh.stdout).toContain('Family data folder [./data]: ');
      expect(fresh.stdout).not.toContain('SQLite path');
      expect(fresh.stdout).toContain('write codes to ./data/outbox');
      const written = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      expect(written).toContain('EXAMIFY_DATA_DIR=./data\n');
      expect(written).not.toContain('DATABASE_URL=');

      const kept = interactiveWriteEnvOnly(dir);
      expect(kept.status).toBe(0);
      expect(kept.stdout).toContain('Keeping existing .env');
      expect(kept.stdout).not.toContain('Family data folder [');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an interactive overwrite keeps pointing at the existing folder and database', () => {
    const dir = tmpDir('examify-install-');
    const volume = tmpDir('examify-volume-');
    try {
      const dest = path.join(dir, '.env');
      // Site URL, sign-in, mail, Turnstile and both keys take their defaults, then
      // "Overwrite? y", then the family data folder prompt.
      const answers = `${'\n'.repeat(6)}y\n\n`;
      fs.writeFileSync(dest, `AUTH_MODE=magic-link\nDATABASE_URL=file:${volume}/examify.sqlite\n`);
      const moved = interactiveWriteEnvOnly(dir, answers);
      expect(moved.status).toBe(0);
      expect(moved.stdout).toContain(`Family data folder [${volume}]: `);
      const rewritten = fs.readFileSync(dest, 'utf8');
      expect(rewritten).toContain(`EXAMIFY_DATA_DIR=${volume}\n`);
      expect(rewritten).toContain(`DATABASE_URL=file:${volume}/examify.sqlite\n`);

      // An installer-written default DATABASE_URL is not carried: <folder>/app.db already.
      fs.writeFileSync(dest, 'AUTH_MODE=magic-link\nDATABASE_URL=file:./data/app.db\n');
      const plain = interactiveWriteEnvOnly(dir, answers);
      expect(plain.status).toBe(0);
      expect(plain.stdout).toContain('Family data folder [./data]: ');
      const written = fs.readFileSync(dest, 'utf8');
      expect(written).toContain('EXAMIFY_DATA_DIR=./data\n');
      expect(written).not.toContain('DATABASE_URL=');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(volume, { recursive: true, force: true });
    }
  });
});

// --- fixtures for full runs: a checkout with a local bare origin, shims on PATH ---

/**
 * Stand-in for scripts/examify-data.mjs: records argv, exits with
 * STUB_EXIT_<COMMAND> when set (stderr and `--json` error shaped like the real
 * CLI's, error code STUB_ERROR), and prints the contracted JSON.
 */
function dataCliStub(version: string): string {
  return `import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = ${JSON.stringify(version)};
const argv = process.argv.slice(2);
const cmd = argv[0] ?? '';
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const repo = option('--repo') ?? process.cwd();
const dataDir = process.env.STUB_DATA_DIR || path.join(repo, 'data');
if (process.env.STUB_LOG) {
  const line = { tool: 'data', version: VERSION, script: process.argv[1], argv };
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(line) + '\\n');
}
const code = Number(process.env['STUB_EXIT_' + cmd.toUpperCase().replace(/-/g, '_')] || 0);
if (code) {
  const reason = process.env.STUB_REASON ? process.env.STUB_REASON + ': ' : '';
  process.stderr.write('examify-data ' + cmd + ': ' + reason + 'stub refusal\\n');
  if (argv.includes('--json')) {
    const error = process.env.STUB_ERROR || 'refused';
    process.stdout.write(JSON.stringify({ ok: false, command: cmd, error }) + '\\n');
  }
  process.exit(code);
}
if (cmd === 'paths' && argv.includes('--json')) {
  const dbPath = path.join(dataDir, 'app.db');
  const outboxDir = path.join(dataDir, 'outbox');
  const out = { repoRoot: repo, dataDir, dataDirSource: 'default', dbPath, outboxDir, databaseUrlExplicit: false };
  process.stdout.write(JSON.stringify(out));
} else if (cmd === 'init') {
  const created = !fs.existsSync(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify({ ok: true, command: cmd, dataDir, created }));
} else if (cmd === 'backup') {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, 'examify-backup-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6) + '-pre-upgrade.tar.gz');
  fs.writeFileSync(archive, 'stub');
  process.stdout.write(JSON.stringify({ archive }));
} else if (cmd === 'migrate-checkout') {
  // M4 stand-in: put tracked family edits back to HEAD once "copied".
  execFileSync('git', ['checkout', 'HEAD', '--', 'content'], { cwd: repo });
}
`;
}

const PNPM_SHIM = `#!/usr/bin/env bash
node -e 'require("fs").appendFileSync(process.env.STUB_LOG, JSON.stringify({ tool: "pnpm", argv: process.argv.slice(1) }) + "\\n")' "$@"
if [ -n "\${PNPM_HIJACK-}" ] && [ "\${1-}" = "install" ]; then
  # Overwrite the running installer in place, like a mid-run git merge would.
  printf 'echo HIJACKED\\nexit 42\\n' > "$PNPM_HIJACK"
fi
exit "\${PNPM_EXIT:-0}"
`;

type Call = { tool: 'pnpm' | 'data'; argv: string[]; version?: string; script?: string };

type Fixture = {
  base: string;
  work: string;
  seed: string;
  bin: string;
  home: string;
  log: string;
  oldSha: string;
};

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Examify Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Examify Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  // Newer git (2.47+) detaches `git maintenance run --auto` after fetch/merge;
  // it can still be writing into .git while a test removes the fixture
  // (ENOTEMPTY in CI). The fixtures never need it.
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'maintenance.auto',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'gc.auto',
  GIT_CONFIG_VALUE_1: '0',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: cwd, ...GIT_ENV },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeFile(file: string, body: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, mode === undefined ? undefined : { mode });
}

/** The upstream installer: the real one with a changed completion line. */
function upstreamInstaller(): string {
  const original = fs.readFileSync(SCRIPT, 'utf8');
  const changed = original.replace(
    'echo "Upgrade complete."',
    'echo "Upgrade complete. [fixture upstream]"',
  );
  expect(changed).not.toBe(original);
  return changed;
}

function makeFixture(options: { upstream?: boolean; env?: boolean } = {}): Fixture {
  const base = tmpDir('examify-upgrade-');
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const work = path.join(base, 'work');
  const bin = path.join(base, 'bin');
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, seed);
  writeFile(path.join(seed, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  writeFile(path.join(seed, 'install.sh'), fs.readFileSync(SCRIPT, 'utf8'), 0o755);
  writeFile(path.join(seed, 'scripts', 'examify-data.mjs'), dataCliStub('local'));
  writeFile(path.join(seed, '.nvmrc'), `${process.versions.node}\n`);
  writeFile(path.join(seed, '.gitignore'), '.env\n.env.local\n/data\nnode_modules\n.next\n');
  writeFile(path.join(seed, 'content', 'subjects', 'demo', 'notes.txt'), 'committed notes\n');
  writeFile(path.join(seed, 'src', 'lib', 'exam', 'data.ts'), 'export const QUESTIONS = 1;\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'initial');
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  const oldSha = git(seed, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', origin, work);
  // A loadable better-sqlite3 for the preflight (the stub CLI never opens it).
  writeFile(
    path.join(work, 'node_modules', 'better-sqlite3', 'package.json'),
    '{"main":"index.js"}',
  );
  writeFile(
    path.join(work, 'node_modules', 'better-sqlite3', 'index.js'),
    'module.exports = {};\n',
  );
  if (options.env !== false) {
    writeFile(
      path.join(work, '.env'),
      [
        'SITE_URL=http://127.0.0.1:9',
        'AUTH_MODE=password',
        'MAIL_TRANSPORT=outbox',
        'ALLOW_LOCAL_OUTBOX=1',
        'DATABASE_URL=file:./data/app.db',
        '',
      ].join('\n'),
      0o600,
    );
  }
  if (options.upstream !== false) {
    writeFile(path.join(seed, 'install.sh'), upstreamInstaller(), 0o755);
    writeFile(path.join(seed, 'scripts', 'examify-data.mjs'), dataCliStub('upstream'));
    git(seed, 'commit', '-q', '-am', 'upstream release');
    git(seed, 'push', '-q');
  }
  writeFile(path.join(bin, 'pnpm'), PNPM_SHIM, 0o755);
  writeFile(path.join(bin, 'corepack'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
  return { base, work, seed, bin, home, log: path.join(base, 'calls.log'), oldSha };
}

function fixtureEnv(
  fx: Fixture,
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PATH: `${fx.bin}:${process.env.PATH}`,
    HOME: fx.home,
    TMPDIR: process.env.TMPDIR,
    EXAMIFY_NONINTERACTIVE: '1',
    STUB_LOG: fx.log,
    ...GIT_ENV,
    ...extra,
  };
}

function runInstaller(fx: Fixture, args: string[], extra: Record<string, string | undefined> = {}) {
  return spawnSync('bash', [path.join(fx.work, 'install.sh'), ...args], {
    cwd: fx.work,
    env: fixtureEnv(fx, extra),
    encoding: 'utf8',
    timeout: 60_000,
  });
}

/** Same, without blocking the event loop (a test server must answer meanwhile). */
function runInstallerAsync(
  fx: Fixture,
  args: string[],
  extra: Record<string, string | undefined> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path.join(fx.work, 'install.sh'), ...args], {
      cwd: fx.work,
      env: fixtureEnv(fx, extra),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function calls(fx: Fixture): Call[] {
  if (!fs.existsSync(fx.log)) return [];
  return fs
    .readFileSync(fx.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call);
}

/** The first recorded data-CLI call for `command` (fails the test when missing). */
function dataCall(fx: Fixture, command: string): Call {
  const call = calls(fx).find((entry) => entry.tool === 'data' && entry.argv[0] === command);
  if (!call) throw new Error(`no examify-data ${command} call recorded`);
  return call;
}

function summary(fx: Fixture): string[] {
  return calls(fx).map((call) =>
    call.tool === 'pnpm' ? `pnpm ${call.argv.join(' ')}` : `data ${call.argv[0]}`,
  );
}

function withFixture(options: Parameters<typeof makeFixture>[0], body: (fx: Fixture) => void) {
  const fx = makeFixture(options);
  try {
    body(fx);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe('install.sh full install (shimmed pnpm and data CLI)', () => {
  it('checks and initialises the data folder through the checkout CLI before installing', () => {
    withFixture({ upstream: false, env: false }, (fx) => {
      const result = runInstaller(fx, [], { SITE_URL: 'https://exam.example.com' });
      expect(result.status).toBe(0);
      expect(summary(fx)).toEqual([
        'data paths',
        'data legacy-check',
        'data init',
        'pnpm install --frozen-lockfile',
        'pnpm db:migrate',
        'pnpm build',
      ]);
      expect(dataCall(fx, 'legacy-check').argv).toEqual(['legacy-check', '--repo', fx.work]);
      const paths = dataCall(fx, 'paths');
      const init = dataCall(fx, 'init');
      expect(paths.argv).toEqual(['paths', '--check', '--repo', fx.work]);
      expect(init.argv).toEqual(['init', '--repo', fx.work, '--json']);
      expect(result.stdout).toContain(`Family data folder: ${fx.work}/data`);
      expect(result.stdout).toContain('Local outbox path: ./data/outbox');
      expect(fs.readFileSync(path.join(fx.work, '.env'), 'utf8')).toContain(
        'EXAMIFY_DATA_DIR=./data',
      );
    });
  });

  it('refuses when the data CLI reports an unsafe folder (exit 3) and installs nothing', () => {
    withFixture({ upstream: false, env: false }, (fx) => {
      const result = runInstaller(fx, [], {
        STUB_EXIT_PATHS: '3',
        STUB_REASON: 'inside_checkout',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'The family data folder is not safe to use (inside_checkout: stub refusal)',
      );
      expect(summary(fx)).toEqual(['data paths']);
    });
  });

  it('refuses when init reports another owner (exit 5)', () => {
    withFixture({ upstream: false, env: false }, (fx) => {
      const result = runInstaller(fx, [], { STUB_EXIT_INIT: '5', STUB_ERROR: 'owner_mismatch' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('belongs to another user');
      expect(summary(fx)).toEqual(['data paths', 'data legacy-check', 'data init']);
    });
  });

  it('refuses a plain install while older family content is still in the checkout', () => {
    withFixture({ upstream: false, env: false }, (fx) => {
      const result = runInstaller(fx, [], { STUB_EXIT_LEGACY_CHECK: '4' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('still holds family content from an older version');
      expect(result.stderr).toContain('./install.sh --upgrade');
      expect(summary(fx)).toEqual(['data paths', 'data legacy-check']);

      fs.rmSync(fx.log);
      const ignored = runInstaller(fx, [], {
        STUB_EXIT_LEGACY_CHECK: '4',
        EXAMIFY_IGNORE_LEGACY_CONTENT: '1',
      });
      expect(ignored.status).toBe(0);
      expect(summary(fx)).not.toContain('data legacy-check');
    });
  });

  it('finishes from main() even when install.sh is overwritten mid-run', () => {
    withFixture({ upstream: false, env: false }, (fx) => {
      const script = path.join(fx.work, 'install.sh');
      const result = runInstaller(fx, [], { PNPM_HIJACK: script });
      expect(fs.readFileSync(script, 'utf8')).toContain('HIJACKED');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Examify is ready.');
      expect(result.stdout).not.toContain('HIJACKED');
    });
  });
});

describe('install.sh --upgrade', () => {
  it('refuses without an existing .env', () => {
    withFixture({ env: false }, (fx) => {
      const result = runInstaller(fx, ['--upgrade']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'No existing install here (no .env, .env.local, .env.production or .env.production.local); run ./install.sh',
      );
      expect(calls(fx)).toEqual([]);
    });
  });

  it('refuses outside a git checkout', () => {
    const dir = tmpDir('examify-upgrade-plain-');
    try {
      writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'project-examify' }));
      writeFile(path.join(dir, '.env'), 'AUTH_MODE=magic-link\n');
      const result = spawnSync('bash', [SCRIPT, '--upgrade'], {
        cwd: dir,
        env: {
          NODE_ENV: 'test',
          PATH: process.env.PATH,
          HOME: dir,
          EXAMIFY_NONINTERACTIVE: '1',
          ...GIT_ENV,
        },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('is not a git checkout');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a branch without an upstream', () => {
    withFixture({}, (fx) => {
      git(fx.work, 'branch', '--unset-upstream');
      const result = runInstaller(fx, ['--upgrade']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Branch main has no upstream');
      expect(calls(fx)).toEqual([]);
    });
  });

  it('refuses when upstream needs another Node major (.nvmrc) before changing anything', () => {
    withFixture({}, (fx) => {
      writeFile(path.join(fx.seed, '.nvmrc'), '20.11.0\n');
      git(fx.seed, 'commit', '-q', '-am', 'node 20');
      git(fx.seed, 'push', '-q');
      const result = runInstaller(fx, ['--upgrade']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('origin/main needs Node 20 (.nvmrc)');
      expect(calls(fx)).toEqual([]);
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(fx.oldSha);
    });
  });

  it('refuses uncommitted edits outside family content, suggesting a commit (never stash)', () => {
    withFixture({}, (fx) => {
      fs.appendFileSync(path.join(fx.work, 'src', 'lib', 'exam', 'data.ts'), '// hand edit\n');
      const result = runInstaller(fx, ['--upgrade']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('src/lib/exam/data.ts');
      expect(result.stderr).toContain("git commit -m 'local questions' -- src/lib/exam/data.ts");
      expect(result.stderr).not.toContain('stash');
      expect(calls(fx)).toEqual([]);
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(fx.oldSha);
    });
  });

  it('refuses when local commits would conflict with upstream (merge-tree)', () => {
    withFixture({}, (fx) => {
      writeFile(
        path.join(fx.seed, 'src', 'lib', 'exam', 'data.ts'),
        'export const QUESTIONS = 2;\n',
      );
      git(fx.seed, 'commit', '-q', '-am', 'upstream questions');
      git(fx.seed, 'push', '-q');
      writeFile(
        path.join(fx.work, 'src', 'lib', 'exam', 'data.ts'),
        'export const QUESTIONS = 3;\n',
      );
      git(fx.work, 'commit', '-q', '-am', 'local questions');
      const localSha = git(fx.work, 'rev-parse', 'HEAD');
      const result = runInstaller(fx, ['--upgrade']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Your local commits conflict with origin/main');
      expect(result.stderr).toContain('Nothing was changed.');
      expect(calls(fx)).toEqual([]);
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(localSha);
    });
  });

  it('refuses while a server answers /api/health (unless --allow-running)', async () => {
    const fx = makeFixture({});
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = String((server.address() as AddressInfo).port);
      const refused = await runInstallerAsync(fx, ['--upgrade'], { PORT: port });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(
        `An Examify server is answering at http://127.0.0.1:${port}/api/health`,
      );
      expect(calls(fx)).toEqual([]);

      const allowed = await runInstallerAsync(fx, ['--upgrade', '--allow-running'], { PORT: port });
      expect(allowed.status).toBe(0);
      expect(summary(fx)).toContain('data backup');
    } finally {
      server.close();
      fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  it('refuses when another user owns the checkout or data (unless --allow-owner-mismatch)', () => {
    withFixture({}, (fx) => {
      writeFile(
        path.join(fx.bin, 'id'),
        '#!/usr/bin/env bash\nif [ "${1-}" = "-u" ]; then echo 4242; else exit 1; fi\n',
        0o755,
      );
      const refused = runInstaller(fx, ['--upgrade']);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('This run is uid 4242');
      expect(refused.stderr).toContain(`checkout ${fx.work} is owned by uid`);
      expect(refused.stderr).toContain('--allow-owner-mismatch');
      expect(calls(fx)).toEqual([]);

      const allowed = runInstaller(fx, ['--upgrade', '--allow-owner-mismatch']);
      expect(allowed.status).toBe(0);
      // Every data CLI command that checks ownership gets the flag, phase 2's verify included.
      for (const command of ['backup', 'migrate-checkout', 'verify']) {
        expect(dataCall(fx, command).argv, command).toContain('--allow-owner-mismatch');
      }
    });
  }, 60_000);

  it('backs up, migrates, merges, then runs the new installer for install/migrate/build/verify', () => {
    withFixture({}, (fx) => {
      // Family edits to tracked content are allowed: migrate-checkout moves them.
      fs.appendFileSync(path.join(fx.work, 'content', 'subjects', 'demo', 'notes.txt'), 'family\n');
      fs.mkdirSync(path.join(fx.work, '.next'));
      const result = runInstaller(fx, ['--upgrade']);
      expect(result.status).toBe(0);
      expect(summary(fx)).toEqual([
        'data paths',
        'data legacy-check',
        'data backup',
        'data migrate-checkout',
        'data paths',
        'pnpm install --frozen-lockfile',
        'pnpm db:migrate',
        'pnpm build',
        'data verify',
      ]);
      const backup = dataCall(fx, 'backup');
      const migrate = dataCall(fx, 'migrate-checkout');
      // Phase 1 runs the upstream data CLI from a temp copy, against this checkout.
      expect(backup.version).toBe('upstream');
      expect(backup.script?.startsWith(fx.work)).toBe(false);
      expect(backup.argv).toEqual([
        'backup',
        '--kind',
        'pre-upgrade',
        '--include-checkout',
        '--repo',
        fx.work,
        '--json',
      ]);
      expect(migrate.version).toBe('upstream');
      // It gets the archive just taken, so it does not back up a second time.
      const archive = path.join(
        fx.work,
        'data',
        'backups',
        fs.readdirSync(path.join(fx.work, 'data', 'backups'))[0]!,
      );
      expect(migrate.argv).toEqual(['migrate-checkout', '--repo', fx.work, '--backup', archive]);
      // Phase 2 is the merged installer and its own data CLI.
      expect(result.stdout).toContain('Upgrade complete. [fixture upstream]');
      const verify = dataCall(fx, 'verify');
      expect(verify.version).toBe('upstream');
      expect(verify.script).toBe(path.join(fx.work, 'scripts', 'examify-data.mjs'));
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(git(fx.work, 'rev-parse', 'origin/main'));
      expect(git(fx.work, 'status', '--porcelain')).toBe('');
      expect(result.stdout).toContain('Pre-upgrade backup: ');
      expect(result.stdout).toContain('Start or restart the server');
      const leftovers = fs
        .readdirSync(fx.work)
        .filter((name) => name.startsWith('.next.pre-upgrade-'));
      expect(leftovers).toEqual([]);
      expect(fs.existsSync(path.join(fx.work, 'data', '.upgrade-state.json'))).toBe(false);

      // A rerun is a no-op merge that still backs up, installs, migrates and verifies.
      const head = git(fx.work, 'rev-parse', 'HEAD');
      fs.rmSync(fx.log);
      const rerun = runInstaller(fx, ['--upgrade']);
      expect(rerun.status).toBe(0);
      expect(summary(fx)).toEqual([
        'data paths',
        'data legacy-check',
        'data backup',
        'data migrate-checkout',
        'data paths',
        'pnpm install --frozen-lockfile',
        'pnpm db:migrate',
        'pnpm build',
        'data verify',
      ]);
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(head);
      expect(fs.readdirSync(path.join(fx.work, 'data', 'backups'))).toHaveLength(2);
    });
  }, 60_000);

  it('stops before merging when the pre-upgrade backup fails', () => {
    withFixture({}, (fx) => {
      const result = runInstaller(fx, ['--upgrade'], { STUB_EXIT_BACKUP: '1' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('The pre-upgrade backup failed');
      expect(summary(fx)).toEqual(['data paths', 'data legacy-check', 'data backup']);
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(fx.oldSha);
    });
  });

  it('keeps the backup as the rollback hint when phase 2 fails', () => {
    withFixture({}, (fx) => {
      const result = runInstaller(fx, ['--upgrade'], { STUB_EXIT_VERIFY: '6' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Upgrade stopped: examify-data verify failed');
      expect(result.stderr).toMatch(/--rollback \S+pre-upgrade\.tar\.gz/);
      expect(fs.existsSync(path.join(fx.work, 'data', '.upgrade-state.json'))).toBe(true);
    });
  }, 60_000);

  it('refuses unknown flags in phase 1 but only warns in phase 2', () => {
    withFixture({ upstream: false }, (fx) => {
      const phase1 = runInstaller(fx, ['--upgrade', '--from-the-future']);
      expect(phase1.status).toBe(2);
      expect(phase1.stderr).toContain('Unknown flag: --from-the-future');
      expect(calls(fx)).toEqual([]);

      const phase2 = runInstaller(fx, ['--upgrade-phase2', '--from-the-future']);
      expect(phase2.status).toBe(0);
      expect(phase2.stderr).toContain('ignoring unknown flag --from-the-future');
      expect(summary(fx)).toEqual([
        'data paths',
        'pnpm install --frozen-lockfile',
        'pnpm db:migrate',
        'pnpm build',
        'data verify',
      ]);
    });
  });
});

function makeArchive(dir: string, manifest: object, withEnv = false): string {
  const staging = path.join(dir, 'staging');
  writeFile(path.join(staging, 'MANIFEST.json'), JSON.stringify(manifest));
  if (withEnv) writeFile(path.join(staging, 'env', '.env'), 'AUTH_MODE=magic-link\n');
  const archive = path.join(dir, 'examify-backup.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', staging, '.']);
  fs.rmSync(staging, { recursive: true, force: true });
  return archive;
}

describe('install.sh --rollback / --restore', () => {
  it('resets to the backed-up commit with --keep and restores with the checkout snapshot', () => {
    withFixture({}, (fx) => {
      git(fx.work, 'pull', '-q');
      const newSha = git(fx.work, 'rev-parse', 'HEAD');
      expect(newSha).not.toBe(fx.oldSha);
      const archive = makeArchive(fx.base, {
        format: 1,
        checkout: { included: true, gitSha: fx.oldSha },
      });
      const result = runInstaller(fx, ['--rollback', archive]);
      expect(result.status).toBe(0);
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(fx.oldSha);
      const restore = dataCall(fx, 'restore');
      expect(restore.argv).toEqual([
        'restore',
        archive,
        '--force',
        '--with-env',
        '--include-checkout',
        '--repo',
        fx.work,
      ]);
      // The data CLI was copied out before the reset (the old sha may lack it).
      expect(restore.version).toBe('upstream');
      expect(restore.script?.startsWith(fx.work)).toBe(false);
      expect(summary(fx)).toEqual([
        'data restore',
        'data paths',
        'pnpm install --frozen-lockfile',
        'pnpm build',
      ]);
      expect(result.stdout).toContain(`Rolled back to ${fx.oldSha.slice(0, 7)}`);
    });
  });

  it('puts back the pre-upgrade build for that commit instead of rebuilding', () => {
    withFixture({}, (fx) => {
      git(fx.work, 'pull', '-q');
      const pre = path.join(fx.work, '.next.pre-upgrade-20260101T000000Z');
      writeFile(path.join(pre, 'BUILD_ID'), 'old-build');
      writeFile(path.join(pre, '.examify-git-sha'), `${fx.oldSha}\n`);
      writeFile(path.join(fx.work, '.next', 'BUILD_ID'), 'new-build');
      const archive = makeArchive(fx.base, {
        format: 1,
        checkout: { included: true, gitSha: fx.oldSha },
      });
      const result = runInstaller(fx, ['--rollback', archive]);
      expect(result.status).toBe(0);
      expect(fs.readFileSync(path.join(fx.work, '.next', 'BUILD_ID'), 'utf8')).toBe('old-build');
      expect(fs.existsSync(pre)).toBe(false);
      expect(summary(fx)).toEqual(['data restore', 'data paths', 'pnpm install --frozen-lockfile']);
    });
  });

  it('refuses a backup without a checkout snapshot and changes nothing', () => {
    withFixture({}, (fx) => {
      git(fx.work, 'pull', '-q');
      const head = git(fx.work, 'rev-parse', 'HEAD');
      const archive = makeArchive(fx.base, { format: 1, checkout: { included: false } });
      const result = runInstaller(fx, ['--rollback', archive]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no checkout snapshot');
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(head);
      expect(calls(fx)).toEqual([]);
    });
  });

  it('--restore installs, restores with the archived .env, migrates, then builds', () => {
    withFixture({ upstream: false, env: false }, (fx) => {
      const archive = makeArchive(fx.base, { format: 1 }, true);
      const result = runInstaller(fx, ['--restore', archive]);
      expect(result.status).toBe(0);
      expect(summary(fx)).toEqual([
        'pnpm install --frozen-lockfile',
        'data restore',
        'pnpm db:migrate',
        'pnpm build',
      ]);
      const restore = dataCall(fx, 'restore');
      expect(restore.argv).toEqual(['restore', archive, '--repo', fx.work, '--with-env']);
      expect(fs.existsSync(path.join(fx.work, '.env'))).toBe(false);
    });
  });

  it('--restore refuses a host data folder when the backup brings its own .env', () => {
    withFixture({ upstream: false, env: false }, (fx) => {
      const archive = makeArchive(fx.base, { format: 1 }, true);
      for (const extra of [
        { EXAMIFY_DATA_DIR: path.join(fx.base, 'elsewhere') },
        { DATABASE_URL: `file:${path.join(fx.base, 'elsewhere', 'app.db')}` },
      ]) {
        const result = runInstaller(fx, ['--restore', archive], extra);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Host EXAMIFY_DATA_DIR / DATABASE_URL is for a new .env');
        expect(calls(fx)).toEqual([]);
        expect(fs.existsSync(path.join(fx.work, '.env'))).toBe(false);
      }
    });
  });

  it('--restore writes a new .env when the backup has none', () => {
    withFixture({ upstream: false, env: false }, (fx) => {
      const archive = makeArchive(fx.base, { format: 1 });
      const result = runInstaller(fx, ['--restore', archive], {
        SITE_URL: 'https://exam.example.com',
      });
      expect(result.status).toBe(0);
      expect(fs.readFileSync(path.join(fx.work, '.env'), 'utf8')).toContain(
        'EXAMIFY_DATA_DIR=./data',
      );
      const restore = dataCall(fx, 'restore');
      expect(restore.argv).toEqual(['restore', archive, '--repo', fx.work]);
      expect(summary(fx)).toEqual([
        'pnpm install --frozen-lockfile',
        'data restore',
        'pnpm db:migrate',
        'pnpm build',
      ]);
    });
  });
});

// --- real end to end: the real install.sh + scripts/examify-data.mjs on a fixture checkout ---
//
// No network and no real build: a local bare `origin`, a pnpm shim on PATH
// (records argv; `db:migrate` stands in for src/lib/db/migrate.ts through the
// checkout's own data CLI and a real SQLite file) and the repo's better-sqlite3
// via EXAMIFY_SQLITE_MODULE.

const REPO_ROOT = process.cwd();
const SQLITE_MODULE = path.join(REPO_ROOT, 'node_modules', 'better-sqlite3');
const JOURNAL = 'src/lib/db/migrations/meta/_journal.json';
const JOURNAL_ENTRIES = (
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, JOURNAL), 'utf8')) as { entries: unknown[] }
).entries.length;

/** What the fixture checkout commits, copied from this repo. */
const REAL_COMMITTED = [
  'install.sh',
  'scripts/examify-data.mjs',
  '.gitignore',
  JOURNAL,
  'content/subjects/demo/subject.json',
  'content/subjects/demo/notes.txt',
  'content/generated/subjects.json',
  'content/generated/questions/biology.json',
  'content/generated/keys/biology.json',
  'src/lib/exam/generated-public.ts',
  'src/lib/exam/generated-keys.server.ts',
];

const UPSTREAM_MARKER = 'echo "Upgrade complete. [fixture upstream]"';

/** `pnpm` on PATH: logs argv; `db:migrate` refuses legacy content, inits the folder, migrates. */
const REAL_PNPM_SHIM = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const argv = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n');
log({ tool: 'pnpm', argv });
if (argv[0] !== 'db:migrate') process.exit(0);
const cli = (...args) =>
  spawnSync(process.execPath, ['scripts/examify-data.mjs', ...args, '--repo', process.cwd()], {
    encoding: 'utf8',
  });
const must = (result) => {
  if (result.status === 0) return result;
  process.stderr.write(result.stderr);
  process.exit(1);
};
if (process.env.EXAMIFY_IGNORE_LEGACY_CONTENT !== '1') must(cli('legacy-check'));
const { dbPath } = JSON.parse(must(cli('paths', '--json')).stdout);
must(cli('init'));
const Database = require(process.env.SHIM_SQLITE_MODULE);
const journal = JSON.parse(fs.readFileSync('${JOURNAL}', 'utf8'));
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('create table if not exists __drizzle_migrations (id integer primary key autoincrement, hash text not null, created_at numeric)');
db.exec('create table if not exists users (id integer primary key, email text not null)');
const have = db.prepare('select count(*) as n from __drizzle_migrations').get().n;
const add = db.prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)');
for (let i = have; i < journal.entries.length; i += 1) add.run('m' + i, i);
db.close();
log({ tool: 'migrate', dbPath });
`;

type RealFixture = {
  base: string;
  origin: string;
  seed: string;
  work: string;
  dataDir: string;
  bin: string;
  home: string;
  log: string;
  port: string;
  oldSha: string;
  upstreamSha: string;
};

const HISTORY = { id: 'history', label: 'History', icon: 'history', l: 0.6, c: 0.1, h: 40 };

async function unusedPort(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return String(port);
}

function makeDbWithUsers(file: string, users: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(
    'create table __drizzle_migrations (id integer primary key autoincrement, hash text not null, created_at numeric)',
  );
  db.exec('create table users (id integer primary key, email text not null)');
  const add = db.prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)');
  for (let i = 0; i < JOURNAL_ENTRIES; i += 1) add.run(`m${i}`, i);
  const addUser = db.prepare('insert into users (email) values (?)');
  for (let i = 0; i < users; i += 1) addUser.run(`user${i}@example.com`);
  db.close();
}

function userCount(file: string): number {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('select count(*) as n from users').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function addUser(file: string, email: string): void {
  const db = new Database(file, { fileMustExist: true });
  try {
    db.prepare('insert into users (email) values (?)').run(email);
  } finally {
    db.close();
  }
}

/** Family content an older runtime left in the checkout. */
function seedLegacyContent(work: string): void {
  writeFile(path.join(work, 'content/subjects/history/subject.json'), JSON.stringify(HISTORY));
  writeFile(
    path.join(work, 'content/subjects/history/bank.ir.json'),
    JSON.stringify({ subject: HISTORY, items: [] }),
  );
  writeFile(path.join(work, 'content/source-pdfs/history/chapter-1.pdf'), '%PDF-1.4 history');
  const catalog = path.join(work, 'content/generated/subjects.json');
  const rows = JSON.parse(fs.readFileSync(catalog, 'utf8')) as unknown[];
  writeFile(catalog, `${JSON.stringify([...rows, HISTORY], null, 2)}\n`);
  writeFile(path.join(work, 'content/generated/questions/history.json'), '{"easy":[]}\n');
  writeFile(path.join(work, 'content/generated/keys/history.json'), '{"history-easy-1":{}}\n');
  fs.appendFileSync(
    path.join(work, 'src/lib/exam/generated-public.ts'),
    '// history registered by the wizard\n',
  );
  writeFile(path.join(work, '.examify-ingest/runs/history.json'), '{"run":1}\n');
}

/** An installer from before the family data folder (no --upgrade, no data CLI). */
const OLD_INSTALLER = '#!/usr/bin/env bash\necho "old installer: $*"\nexit 3\n';

/**
 * `dataInCheckout`: the older layout (DATABASE_URL=file:./data/app.db, no
 * EXAMIFY_DATA_DIR); otherwise EXAMIFY_DATA_DIR names a folder outside.
 * `predatesDataCli`: the checkout's commit has no scripts/examify-data.mjs
 * and an old install.sh; upstream adds both.
 */
async function makeRealFixture({
  dataInCheckout = false,
  predatesDataCli = false,
  upstreamAdds = {} as Record<string, string>,
} = {}): Promise<RealFixture> {
  const base = tmpDir('examify-real-');
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const work = path.join(base, 'work');
  const bin = path.join(base, 'bin');
  const home = path.join(base, 'home');
  const dataDir = dataInCheckout ? path.join(work, 'data') : path.join(base, 'family-data');
  const port = await unusedPort();
  fs.mkdirSync(home);
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, seed);
  writeFile(
    path.join(seed, 'package.json'),
    JSON.stringify({ name: 'project-examify', version: '1.0.0' }),
  );
  writeFile(path.join(seed, '.nvmrc'), `${process.versions.node}\n`);
  const copyFromRepo = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(seed, rel));
  };
  for (const rel of REAL_COMMITTED) copyFromRepo(rel);
  if (predatesDataCli) {
    fs.rmSync(path.join(seed, 'scripts'), { recursive: true });
    writeFile(path.join(seed, 'install.sh'), OLD_INSTALLER, 0o755);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'initial');
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  const oldSha = git(seed, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', origin, work);

  const installer = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf8');
  const upstream = installer.replace('echo "Upgrade complete."', UPSTREAM_MARKER);
  expect(upstream).not.toBe(installer);
  writeFile(path.join(seed, 'install.sh'), upstream, 0o755);
  if (predatesDataCli) copyFromRepo('scripts/examify-data.mjs');
  for (const [rel, body] of Object.entries(upstreamAdds)) writeFile(path.join(seed, rel), body);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'upstream release');
  git(seed, 'push', '-q');
  const upstreamSha = git(seed, 'rev-parse', 'HEAD');

  writeFile(
    path.join(work, '.env'),
    [
      `SITE_URL=http://127.0.0.1:${port}`,
      `PORT=${port}`,
      'AUTH_SECRET=real-fixture-auth-secret-0123456789abcdef',
      'AUTH_MODE=password',
      'MAIL_TRANSPORT=outbox',
      'ALLOW_LOCAL_OUTBOX=1',
      dataInCheckout ? 'DATABASE_URL=file:./data/app.db' : `EXAMIFY_DATA_DIR=${dataDir}`,
      '',
    ].join('\n'),
    0o600,
  );
  makeDbWithUsers(path.join(dataDir, 'app.db'), 3);
  seedLegacyContent(work);
  fs.mkdirSync(path.join(work, '.next'));
  writeFile(path.join(bin, 'pnpm'), REAL_PNPM_SHIM, 0o755);
  writeFile(path.join(bin, 'corepack'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
  return {
    base,
    origin,
    seed,
    work,
    dataDir,
    bin,
    home,
    log: path.join(base, 'calls.log'),
    port,
    oldSha,
    upstreamSha,
  };
}

/** `script`: pipe this installer text into `bash -s --` (curl | bash) instead of running cwd's. */
function runReal(
  fx: RealFixture,
  cwd: string,
  args: string[],
  extra: Record<string, string | undefined> = {},
  script?: string,
) {
  const argv =
    script === undefined ? [path.join(cwd, 'install.sh'), ...args] : ['-s', '--', ...args];
  // No NODE_ENV: a host shell running the installer does not set one.
  const env: Record<string, string | undefined> = {
    PATH: `${fx.bin}:${process.env.PATH}`,
    HOME: fx.home,
    TMPDIR: process.env.TMPDIR,
    EXAMIFY_SQLITE_MODULE: SQLITE_MODULE,
    SHIM_SQLITE_MODULE: SQLITE_MODULE,
    PORT: fx.port,
    STUB_LOG: fx.log,
    ...GIT_ENV,
    ...extra,
  };
  return spawnSync('bash', argv, {
    cwd,
    input: script,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function pnpmCalls(fx: RealFixture): string[] {
  if (!fs.existsSync(fx.log)) return [];
  return fs
    .readFileSync(fx.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { tool: string; argv?: string[]; dbPath?: string })
    .map((entry) =>
      entry.tool === 'pnpm' ? `pnpm ${entry.argv?.join(' ')}` : `migrate ${entry.dbPath}`,
    );
}

/** Every file under `dir`, relative, sorted (so trees compare as lists). */
function listTree(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((rel) => fs.statSync(path.join(dir, rel)).isFile())
    .sort();
}

function checkoutLeftovers(work: string): string {
  return git(work, 'status', '--porcelain', '--ignored=traditional', '--', 'content', 'src');
}

function preUpgradeArchives(dataDir: string): string[] {
  const dir = path.join(dataDir, 'backups');
  return fs
    .readdirSync(dir)
    .filter((name) => /-pre-upgrade-[0-9a-f]{7}\.tar\.gz$/.test(name))
    .map((name) => path.join(dir, name));
}

type LegacySnapshot = { status: string; files: Record<string, string>; env: string };

const LEGACY_FILES = [
  'content/subjects/history/subject.json',
  'content/subjects/history/bank.ir.json',
  'content/source-pdfs/history/chapter-1.pdf',
  'content/generated/subjects.json',
  'content/generated/questions/history.json',
  'content/generated/keys/history.json',
  'src/lib/exam/generated-public.ts',
  '.examify-ingest/runs/history.json',
];

function familyStatus(work: string): string {
  return git(
    work,
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--ignored=traditional',
    '--',
    'content',
    'src',
    '.examify-ingest',
  );
}

/** The checkout's family content (and .env) before an upgrade touches it. */
function legacySnapshot(fx: RealFixture): LegacySnapshot {
  return {
    status: familyStatus(fx.work),
    files: Object.fromEntries(
      LEGACY_FILES.map((rel) => [rel, fs.readFileSync(path.join(fx.work, rel), 'utf8')]),
    ),
    env: fs.readFileSync(path.join(fx.work, '.env'), 'utf8'),
  };
}

function expectLegacyBack(fx: RealFixture, before: LegacySnapshot): void {
  for (const [rel, body] of Object.entries(before.files)) {
    expect(fs.readFileSync(path.join(fx.work, rel), 'utf8'), rel).toBe(body);
  }
  expect(familyStatus(fx.work)).toBe(before.status);
}

async function upgradedFixture(options: Parameters<typeof makeRealFixture>[0] = {}): Promise<{
  fx: RealFixture;
  result: ReturnType<typeof runReal>;
  archive: string;
  before: LegacySnapshot;
}> {
  const fx = await makeRealFixture(options);
  const before = legacySnapshot(fx);
  const result = runReal(fx, fx.work, ['--upgrade', '--yes']);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const archives = preUpgradeArchives(fx.dataDir);
  expect(archives).toHaveLength(1);
  return { fx, result, archive: archives[0]!, before };
}

/** A `git` on PATH whose `git merge` fails while FAIL_GIT_MERGE is set. */
function failingMergeGit(fx: RealFixture): void {
  const real = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFile(
    path.join(fx.bin, 'git'),
    [
      '#!/usr/bin/env bash',
      'if [ -n "${FAIL_GIT_MERGE-}" ] && [ "${1-}" = merge ]; then',
      '  echo "fatal: simulated merge failure" >&2',
      '  exit 128',
      'fi',
      `exec ${JSON.stringify(real)} "$@"`,
      '',
    ].join('\n'),
    0o755,
  );
}

describe('install.sh end to end (real data CLI, fixture checkout)', () => {
  it('a fresh install sets up the data folder before pnpm install, without better-sqlite3', async () => {
    const fx = await makeRealFixture();
    try {
      // Anything that loads better-sqlite3 before `pnpm install` fails loudly.
      const noSqlite = path.join(fx.base, 'no-sqlite.cjs');
      writeFile(noSqlite, "throw new Error('better-sqlite3 loaded before pnpm install');\n");
      const clone = path.join(fx.base, 'fresh');
      git(fx.base, 'clone', '-q', fx.origin, clone);
      const dataDir = path.join(fx.base, 'fresh-data');
      const result = runReal(fx, clone, ['--yes', '--data-dir', dataDir], {
        SITE_URL: 'https://exam.example.com',
        EXAMIFY_SQLITE_MODULE: noSqlite,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.readFileSync(path.join(clone, '.env'), 'utf8')).toContain(
        `EXAMIFY_DATA_DIR=${dataDir}\n`,
      );
      expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(fs.readFileSync(path.join(dataDir, '.gitignore'), 'utf8')).toBe('*\n');
      expect(fs.existsSync(path.join(dataDir, '.examify-data.json'))).toBe(true);
      expect(pnpmCalls(fx)).toEqual([
        'pnpm install --frozen-lockfile',
        'pnpm db:migrate',
        `migrate ${path.join(dataDir, 'app.db')}`,
        'pnpm build',
      ]);
      expect(fs.existsSync(path.join(clone, 'data'))).toBe(false);
      expect(checkoutLeftovers(clone)).toBe('');
      expect(result.stdout).toContain(`Family data folder: ${dataDir}`);
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);

  it('a fresh install refuses a folder shared with files that are not Examify’s', async () => {
    const fx = await makeRealFixture();
    try {
      const clone = path.join(fx.base, 'fresh');
      git(fx.base, 'clone', '-q', fx.origin, clone);
      const shared = path.join(fx.base, 'shared');
      writeFile(path.join(shared, 'app.db'), '');
      writeFile(path.join(shared, 'notes.txt'), 'someone else');
      const result = runReal(fx, clone, ['--yes', '--data-dir', shared], {
        SITE_URL: 'https://exam.example.com',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("already holds files that are not Examify's");
      expect(result.stderr).not.toContain('belongs to another user');
      expect(fs.readdirSync(shared).sort()).toEqual(['app.db', 'notes.txt']);
      expect(pnpmCalls(fx)).toEqual([]);
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);

  it.each([
    ['a family data folder outside the checkout', false],
    ['the older ./data layout (DATABASE_URL only)', true],
  ])(
    '--upgrade with %s backs up, moves the family content out, merges and finishes with the new installer',
    async (_layout, dataInCheckout) => {
      const { fx, result, archive } = await upgradedFixture({ dataInCheckout });
      try {
        // The pre-upgrade backup: private, in the data folder, named after the old commit.
        expect(fs.statSync(archive).mode & 0o777).toBe(0o600);
        expect(path.basename(archive)).toContain(`-pre-upgrade-${fx.oldSha.slice(0, 7)}.tar.gz`);
        expect(result.stdout).toContain(`Pre-upgrade backup: ${archive}`);

        // The family content now lives in the data folder …
        const family = (rel: string) => fs.readFileSync(path.join(fx.dataDir, rel), 'utf8');
        expect(JSON.parse(family('content/subjects/history/subject.json'))).toEqual(HISTORY);
        expect(family('content/source-pdfs/history/chapter-1.pdf')).toBe('%PDF-1.4 history');
        expect(JSON.parse(family('content/generated/subjects.json'))).toEqual([HISTORY]);
        expect(family('content/generated/questions/history.json')).toBe('{"easy":[]}\n');
        const keys = path.join(fx.dataDir, 'content/generated/keys/history.json');
        expect(fs.statSync(keys).mode & 0o777).toBe(0o600);
        expect(family('.examify-ingest/runs/history.json')).toBe('{"run":1}\n');
        expect(userCount(path.join(fx.dataDir, 'app.db'))).toBe(3);
        // … and the checkout holds only committed content again.
        expect(checkoutLeftovers(fx.work)).toBe('');
        expect(fs.existsSync(path.join(fx.work, '.examify-ingest'))).toBe(false);
        expect(
          fs.readFileSync(path.join(fx.work, 'src/lib/exam/generated-public.ts'), 'utf8'),
        ).toBe(fs.readFileSync(path.join(REPO_ROOT, 'src/lib/exam/generated-public.ts'), 'utf8'));

        // Merged, and phase 2 was the upstream installer.
        expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(fx.upstreamSha);
        expect(result.stdout).toContain('Upgrade complete. [fixture upstream]');
        expect(pnpmCalls(fx)).toEqual([
          'pnpm install --frozen-lockfile',
          'pnpm db:migrate',
          `migrate ${path.join(fx.dataDir, 'app.db')}`,
          'pnpm build',
        ]);
        expect(result.stdout).toContain('Verify passed.');
        expect(fs.existsSync(path.join(fx.dataDir, '.upgrade-state.json'))).toBe(false);
        expect(fs.readdirSync(fx.work).filter((name) => name.startsWith('.next'))).toEqual([]);

        // A rerun has nothing to move or merge and still succeeds.
        const dataBefore = listTree(path.join(fx.dataDir, 'content'));
        fs.rmSync(fx.log);
        const rerun = runReal(fx, fx.work, ['--upgrade', '--yes']);
        expect(rerun.status, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
        expect(rerun.stdout).toContain('nothing to migrate');
        expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(fx.upstreamSha);
        expect(checkoutLeftovers(fx.work)).toBe('');
        expect(listTree(path.join(fx.dataDir, 'content'))).toEqual(dataBefore);
        expect(pnpmCalls(fx)).toContain('pnpm build');
      } finally {
        fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
    120_000,
  );

  it('the first upgrade of a checkout without the data CLI works piped (curl | bash -s -- --upgrade)', async () => {
    const fx = await makeRealFixture({ predatesDataCli: true });
    try {
      expect(fs.existsSync(path.join(fx.work, 'scripts'))).toBe(false);
      // What `curl …/main/install.sh` serves: the upstream installer.
      const upstream = git(fx.origin, 'show', 'main:install.sh');
      const result = runReal(fx, fx.work, ['--upgrade', '--yes'], {}, `${upstream}\n`);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).not.toContain('old installer');
      expect(result.stdout).toContain('Upgrade complete. [fixture upstream]');
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(fx.upstreamSha);
      expect(preUpgradeArchives(fx.dataDir)).toHaveLength(1);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(fx.dataDir, 'content/generated/subjects.json'), 'utf8'),
        ),
      ).toEqual([HISTORY]);
      expect(
        fs.existsSync(path.join(fx.dataDir, 'content/source-pdfs/history/chapter-1.pdf')),
      ).toBe(true);
      expect(checkoutLeftovers(fx.work)).toBe('');
      expect(result.stdout).toContain('Verify passed.');
      expect(pnpmCalls(fx)).toContain('pnpm build');
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);

  it('--rollback puts back the old commit, the checkout content, the database and .env', async () => {
    const { fx, archive, before } = await upgradedFixture();
    try {
      // Life after the upgrade: a new account, an edited .env.
      addUser(path.join(fx.dataDir, 'app.db'), 'after-upgrade@example.com');
      fs.appendFileSync(path.join(fx.work, '.env'), 'SMTP_FROM=after@example.com\n');
      const envAfter = fs.readFileSync(path.join(fx.work, '.env'), 'utf8');
      fs.rmSync(fx.log);

      const result = runReal(fx, fx.work, ['--rollback', archive, '--yes']);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(fx.oldSha);
      expectLegacyBack(fx, before);
      expect(userCount(path.join(fx.dataDir, 'app.db'))).toBe(3);
      expect(fs.readFileSync(path.join(fx.work, '.env'), 'utf8')).toBe(before.env);
      const savedEnv = fs
        .readdirSync(fx.work)
        .filter((name) => name.startsWith('.env.before-restore-'));
      expect(savedEnv).toHaveLength(1);
      expect(fs.readFileSync(path.join(fx.work, savedEnv[0]!), 'utf8')).toBe(envAfter);

      // The migrated data-folder content was moved aside, not deleted.
      const aside = fs.readdirSync(fx.dataDir).filter((name) => name.startsWith('before-restore-'));
      expect(aside).toHaveLength(1);
      const asideDir = path.join(fx.dataDir, aside[0]!);
      expect(fs.existsSync(path.join(asideDir, 'content/subjects/history/bank.ir.json'))).toBe(
        true,
      );
      expect(userCount(path.join(asideDir, 'db', 'app.db'))).toBe(4);
      expect(fs.existsSync(path.join(fx.dataDir, 'content'))).toBe(false);
      expect(fs.existsSync(archive)).toBe(true);
      expect(pnpmCalls(fx)).toEqual(['pnpm install --frozen-lockfile', 'pnpm build']);
      expect(result.stdout).toContain(`Rolled back to ${fx.oldSha.slice(0, 7)}`);
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);

  it('--restore on a fresh clone lands the data in the folder the archived .env names', async () => {
    const { fx } = await upgradedFixture();
    try {
      const backupEnv: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: fx.home,
        EXAMIFY_SQLITE_MODULE: SQLITE_MODULE,
      };
      const backup = spawnSync(
        process.execPath,
        ['scripts/examify-data.mjs', 'backup', '--out', path.join(fx.base, 'transfer'), '--json'],
        { cwd: fx.work, env: backupEnv as NodeJS.ProcessEnv, encoding: 'utf8' },
      );
      expect(backup.status, backup.stderr).toBe(0);
      const { archive } = JSON.parse(backup.stdout) as { archive: string };
      const envBefore = fs.readFileSync(path.join(fx.work, '.env'), 'utf8');
      const familyBefore = listTree(path.join(fx.dataDir, 'content'));
      // A new machine: this machine's data folder is not there.
      fs.renameSync(fx.dataDir, path.join(fx.base, 'old-machine-data'));
      const clone = path.join(fx.base, 'second');
      git(fx.base, 'clone', '-q', fx.origin, clone);
      fs.rmSync(fx.log);

      const result = runReal(fx, clone, ['--restore', archive, '--yes']);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.readFileSync(path.join(clone, '.env'), 'utf8')).toBe(envBefore);
      expect(fs.statSync(path.join(clone, '.env')).mode & 0o777).toBe(0o600);
      expect(userCount(path.join(fx.dataDir, 'app.db'))).toBe(3);
      expect(listTree(path.join(fx.dataDir, 'content'))).toEqual(familyBefore);
      expect(
        fs.statSync(path.join(fx.dataDir, 'content/generated/keys/history.json')).mode & 0o777,
      ).toBe(0o600);
      // db:migrate ran against that same database; nothing was left in ./data.
      expect(pnpmCalls(fx)).toEqual([
        'pnpm install --frozen-lockfile',
        'pnpm db:migrate',
        `migrate ${path.join(fx.dataDir, 'app.db')}`,
        'pnpm build',
      ]);
      expect(fs.existsSync(path.join(clone, 'data'))).toBe(false);
      expect(checkoutLeftovers(clone)).toBe('');
      expect(result.stdout).toContain('Examify is ready.');
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);
});

function reportedArchives(output: string): string[] {
  return [...output.matchAll(/Pre-upgrade backup: (\S+)/g)].map((match) => match[1]!);
}

describe('install.sh upgrade recovery (real data CLI, fixture checkout)', () => {
  it('finishes when an older version left empty folders behind, and a rerun succeeds', async () => {
    const fx = await makeRealFixture();
    try {
      // A detached upload leaves its subject folder; the generate cache leaves ir/.
      fs.mkdirSync(path.join(fx.work, 'content/source-pdfs/geography'), { recursive: true });
      fs.mkdirSync(path.join(fx.work, '.examify-ingest/cache/ir'), { recursive: true });
      const result = runReal(fx, fx.work, ['--upgrade', '--yes']);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(path.join(fx.work, 'content/source-pdfs'))).toBe(false);
      expect(fs.existsSync(path.join(fx.work, '.examify-ingest'))).toBe(false);
      expect(result.stdout).toContain('Verify passed.');
      const rerun = runReal(fx, fx.work, ['--upgrade', '--yes']);
      expect(rerun.status, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);

  it('refuses before the backup when upstream adds a file that exists here untracked', async () => {
    const fx = await makeRealFixture({ predatesDataCli: true, upstreamAdds: { NEWFILE: 'x\n' } });
    try {
      writeFile(path.join(fx.work, 'NEWFILE'), 'mine\n');
      const before = legacySnapshot(fx);
      const upstream = git(fx.origin, 'show', 'main:install.sh');
      const result = runReal(fx, fx.work, ['--upgrade', '--yes'], {}, `${upstream}\n`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('  NEWFILE');
      expect(result.stderr).toContain('Nothing was changed.');
      expect(fs.existsSync(path.join(fx.dataDir, 'backups'))).toBe(false);
      expectLegacyBack(fx, before);
      expect(fs.existsSync(path.join(fx.work, '.next'))).toBe(true);
      expect(fs.readFileSync(path.join(fx.work, 'NEWFILE'), 'utf8')).toBe('mine\n');
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(fx.oldSha);
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);

  it('a first upgrade whose merge fails points at the piped installer, and that rollback works', async () => {
    const fx = await makeRealFixture({ predatesDataCli: true });
    try {
      failingMergeGit(fx);
      const before = legacySnapshot(fx);
      const upstream = `${git(fx.origin, 'show', 'main:install.sh')}\n`;
      const failed = runReal(
        fx,
        fx.work,
        ['--upgrade', '--yes'],
        { FAIL_GIT_MERGE: '1' },
        upstream,
      );
      expect(failed.status).toBe(1);
      const [archive] = reportedArchives(failed.stdout);
      // The checkout's own install.sh is the old one: only the piped form works.
      expect(failed.stderr).toContain('git show origin/main:install.sh | bash -s -- --upgrade');
      expect(failed.stderr).toContain(
        `git show origin/main:install.sh | bash -s -- --rollback ${archive}`,
      );
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(fx.oldSha);
      expect(fs.existsSync(path.join(fx.work, 'content/subjects/history'))).toBe(false);
      expect(fs.existsSync(path.join(fx.work, '.next'))).toBe(false);

      const rollback = runReal(fx, fx.work, ['--rollback', archive!, '--yes'], {}, upstream);
      expect(rollback.status, `${rollback.stdout}\n${rollback.stderr}`).toBe(0);
      expectLegacyBack(fx, before);
      expect(fs.existsSync(path.join(fx.work, '.next'))).toBe(true);
      expect(userCount(path.join(fx.dataDir, 'app.db'))).toBe(3);
      expect(fs.existsSync(path.join(fx.dataDir, '.upgrade-state.json'))).toBe(false);
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);

  it('a rerun after a failed merge keeps the first backup as the way back', async () => {
    const fx = await makeRealFixture();
    try {
      failingMergeGit(fx);
      const before = legacySnapshot(fx);
      const failed = runReal(fx, fx.work, ['--upgrade', '--yes'], { FAIL_GIT_MERGE: '1' });
      expect(failed.status).toBe(1);
      const [first] = reportedArchives(failed.stdout);
      const state = JSON.parse(
        fs.readFileSync(path.join(fx.dataDir, '.upgrade-state.json'), 'utf8'),
      ) as { archive: string; fromSha: string };
      expect(state).toMatchObject({ archive: first, fromSha: fx.oldSha });

      const rerun = runReal(fx, fx.work, ['--upgrade', '--yes']);
      expect(rerun.status, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
      expect(rerun.stdout).toContain(`its backup stays the rollback point: ${first}`);
      // The newest snapshot is taken too, but the report names the first one.
      const reported = reportedArchives(rerun.stdout);
      expect(reported.at(-1)).toBe(first);
      expect(preUpgradeArchives(fx.dataDir)).toHaveLength(2);

      const rollback = runReal(fx, fx.work, ['--rollback', first!, '--yes']);
      expect(rollback.status, `${rollback.stdout}\n${rollback.stderr}`).toBe(0);
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(fx.oldSha);
      expectLegacyBack(fx, before);
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);

  it('--rollback finishes after an unmarked pre-upgrade backup and a later backup --out data/archives', async () => {
    const { fx, archive, before } = await upgradedFixture({ dataInCheckout: true });
    try {
      const extra = spawnSync(
        process.execPath,
        ['scripts/examify-data.mjs', 'backup', '--out', 'data/archives', '--json'],
        {
          cwd: fx.work,
          env: {
            PATH: process.env.PATH,
            HOME: fx.home,
            EXAMIFY_SQLITE_MODULE: SQLITE_MODULE,
          } as Record<string, string | undefined> as NodeJS.ProcessEnv,
          encoding: 'utf8',
        },
      );
      expect(extra.status, extra.stderr).toBe(0);
      fs.rmSync(fx.log);
      const result = runReal(fx, fx.work, ['--rollback', archive, '--yes']);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expectLegacyBack(fx, before);
      expect(userCount(path.join(fx.dataDir, 'app.db'))).toBe(3);
      expect(fs.readdirSync(path.join(fx.dataDir, 'archives'))).toHaveLength(1);
      expect(pnpmCalls(fx)).toEqual(['pnpm install --frozen-lockfile', 'pnpm build']);
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);
});

/** An HTTP server answering /api/health with `status` and `body` on a free port. */
async function healthServer(status: number, body: string) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: String((server.address() as AddressInfo).port),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('install.sh upgrade guards (shimmed pnpm and data CLI)', () => {
  it('counts an unhealthy server (503 {"ok":false}) as running', async () => {
    const fx = makeFixture({});
    const server = await healthServer(503, '{"ok":false,"reason":"db_error"}');
    try {
      const result = await runInstallerAsync(fx, ['--upgrade'], { PORT: server.port });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`answering at http://127.0.0.1:${server.port}/api/health`);
      expect(calls(fx)).toEqual([]);
    } finally {
      await server.close();
      fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  it('--rollback --allow-running still refuses a local Examify before resetting the checkout', async () => {
    const fx = makeFixture({});
    const server = await healthServer(200, '{"ok":true}');
    try {
      git(fx.work, 'pull', '-q');
      const head = git(fx.work, 'rev-parse', 'HEAD');
      const archive = makeArchive(fx.base, {
        format: 1,
        checkout: { included: true, gitSha: fx.oldSha },
      });
      const result = await runInstallerAsync(fx, ['--rollback', archive, '--allow-running'], {
        PORT: server.port,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('the restore will not replace its database');
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(head);
      expect(calls(fx)).toEqual([]);
    } finally {
      await server.close();
      fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  it('records the rollback point before moving anything, and only keeps it while it is the way back', () => {
    withFixture({}, (fx) => {
      const state = path.join(fx.work, 'data', '.upgrade-state.json');
      // Stopped before anything moved (no family content): the rerun's backup is as good and newer.
      const first = runInstaller(fx, ['--upgrade'], { STUB_EXIT_MIGRATE_CHECKOUT: '1' });
      expect(first.status).toBe(1);
      const [a] = reportedArchives(first.stdout);
      expect(JSON.parse(fs.readFileSync(state, 'utf8'))).toMatchObject({
        archive: a,
        fromSha: fx.oldSha,
        movesCheckoutContent: false,
      });
      expect(first.stderr).toContain('Fix it and re-run: ./install.sh --upgrade');
      expect(first.stderr).toContain(`Or go back: ./install.sh --rollback ${a}`);
      const second = runInstaller(fx, ['--upgrade'], {
        STUB_EXIT_LEGACY_CHECK: '4',
        STUB_EXIT_MIGRATE_CHECKOUT: '1',
      });
      expect(second.status).toBe(1);
      const [b] = reportedArchives(second.stdout);
      expect(b).not.toBe(a);
      expect(second.stderr).toContain(`--rollback ${b}`);
      // It had family content to move: the next run keeps that backup.
      const third = runInstaller(fx, ['--upgrade']);
      expect(third.status, third.stderr).toBe(0);
      expect(third.stdout).toContain(`its backup stays the rollback point: ${b}`);
      expect(reportedArchives(third.stdout).at(-1)).toBe(b);
      expect(fs.existsSync(state)).toBe(false);
    });
  }, 60_000);

  it('a failure to record the upgrade stops it before anything moves, without a stack trace', () => {
    withFixture({}, (fx) => {
      fs.mkdirSync(path.join(fx.work, 'data', '.upgrade-state.json.tmp'), { recursive: true });
      const result = runInstaller(fx, ['--upgrade']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Could not record the upgrade');
      expect(result.stderr).toContain('Nothing was moved or merged.');
      expect(result.stderr).not.toMatch(/^\s+at /m);
      expect(summary(fx)).not.toContain('data migrate-checkout');
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(fx.oldSha);
    });
  });

  it('refuses before anything when the upstream installer needs a newer Node', () => {
    withFixture({}, (fx) => {
      writeFile(
        path.join(fx.seed, 'install.sh'),
        upstreamInstaller().replace(/MIN_NODE="[0-9.]+"/, 'MIN_NODE="22.999.0"'),
        0o755,
      );
      git(fx.seed, 'commit', '-q', '-am', 'needs a newer node');
      git(fx.seed, 'push', '-q');
      const result = runInstaller(fx, ['--upgrade']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('origin/main needs Node 22.999.0 or newer');
      expect(result.stderr).toContain('Nothing was changed.');
      expect(calls(fx)).toEqual([]);
    });
  });

  it('phase 2 names the backup when the Node.js or pnpm setup fails', () => {
    withFixture({ upstream: false }, (fx) => {
      writeFile(
        path.join(fx.work, 'data', '.upgrade-state.json'),
        JSON.stringify({ fromSha: fx.oldSha, archive: '/backups/pre.tar.gz' }),
      );
      writeFile(
        path.join(fx.bin, 'corepack'),
        '#!/usr/bin/env bash\n[ "${1-}" = prepare ] && exit 1\nexit 0\n',
        0o755,
      );
      const pnpmFails = runInstaller(fx, ['--upgrade-phase2']);
      expect(pnpmFails.status).toBe(1);
      expect(pnpmFails.stderr).toContain('Upgrade stopped: setting up pnpm failed');
      expect(pnpmFails.stderr).toContain('Or go back: ./install.sh --rollback /backups/pre.tar.gz');

      const realNode = execFileSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).trim();
      writeFile(
        path.join(fx.bin, 'node'),
        `#!/usr/bin/env bash\nif [ "\${1-}" = -p ]; then echo 22.0.0; exit 0; fi\nexec ${JSON.stringify(realNode)} "$@"\n`,
        0o755,
      );
      const nodeFails = runInstaller(fx, ['--upgrade-phase2']);
      expect(nodeFails.status).toBe(1);
      expect(nodeFails.stderr).toContain('Upgrade stopped: the Node.js check failed');
      expect(nodeFails.stderr).toContain('--rollback /backups/pre.tar.gz');
    });
  });
});

describe('install.sh --restore of an install configured through .env.local (real data CLI)', () => {
  it('restores the archived .env.local, puts the data where it points, and writes no .env', async () => {
    const fx = await makeRealFixture();
    try {
      fs.renameSync(path.join(fx.work, '.env'), path.join(fx.work, '.env.local'));
      const envLocal = fs.readFileSync(path.join(fx.work, '.env.local'), 'utf8');
      const backupEnv: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: fx.home,
        EXAMIFY_SQLITE_MODULE: SQLITE_MODULE,
      };
      const backup = spawnSync(
        process.execPath,
        ['scripts/examify-data.mjs', 'backup', '--out', path.join(fx.base, 'transfer'), '--json'],
        { cwd: fx.work, env: backupEnv as NodeJS.ProcessEnv, encoding: 'utf8' },
      );
      expect(backup.status, backup.stderr).toBe(0);
      const { archive } = JSON.parse(backup.stdout) as { archive: string };
      expect(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })).toContain(
        'env/.env.local\n',
      );
      // A new machine: this machine's data folder is not there.
      fs.renameSync(fx.dataDir, path.join(fx.base, 'old-machine-data'));
      const clone = path.join(fx.base, 'second');
      git(fx.base, 'clone', '-q', fx.origin, clone);

      const result = runReal(fx, clone, ['--restore', archive, '--yes']);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.readFileSync(path.join(clone, '.env.local'), 'utf8')).toBe(envLocal);
      expect(fs.existsSync(path.join(clone, '.env'))).toBe(false);
      expect(userCount(path.join(fx.dataDir, 'app.db'))).toBe(3);
      expect(pnpmCalls(fx)).toContain(`migrate ${path.join(fx.dataDir, 'app.db')}`);
      expect(fs.existsSync(path.join(clone, 'data'))).toBe(false);
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);
});

describe('install.sh keeps the database and outbox out of the checkout', () => {
  it('refuses a host DATABASE_URL inside the checkout before writing .env', () => {
    const dir = tmpDir('examify-install-db-');
    try {
      for (const url of ['file:./app.db', 'file:./src/examify.db']) {
        const result = writeEnvOnly(dir, dataEnv({ DATABASE_URL: url }));
        expect(result.status, url).toBe(1);
        expect(result.stderr).toContain('DATABASE_URL points inside the checkout');
        expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
      }
      expect(writeEnvOnly(dir, dataEnv({ DATABASE_URL: 'file:./data/app.db' })).status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a kept env file whose DATABASE_URL or MAIL_OUTBOX_DIR is inside the checkout, naming the file', () => {
    const dir = tmpDir('examify-install-kept-db-');
    try {
      writeFile(path.join(dir, '.env'), 'AUTH_MODE=magic-link\nEXAMIFY_DATA_DIR=./data\n');
      writeFile(path.join(dir, '.env.local'), 'DATABASE_URL=file:./app.db\n');
      const db = writeEnvOnly(dir, dataEnv({ AUTH_MODE: undefined }));
      expect(db.status).toBe(1);
      expect(db.stderr).toContain('.env.local has DATABASE_URL=file:./app.db');
      expect(db.stderr).toContain('DATABASE_URL points inside the checkout');

      writeFile(path.join(dir, '.env.local'), 'MAIL_OUTBOX_DIR=outbox\n');
      const outbox = writeEnvOnly(dir, dataEnv({ AUTH_MODE: undefined }));
      expect(outbox.status).toBe(1);
      expect(outbox.stderr).toContain('.env.local has MAIL_OUTBOX_DIR=outbox');

      writeFile(path.join(dir, '.env.local'), 'MAIL_OUTBOX_DIR=data/outbox\n');
      expect(writeEnvOnly(dir, dataEnv({ AUTH_MODE: undefined })).status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('install.sh refuses path values Next and the CLIs would read differently', () => {
  it('refuses a host DATABASE_URL with $, ~ or " #" before writing .env', () => {
    const dir = tmpDir('examify-install-db-value-');
    try {
      for (const url of ['file:$HOME/app.db', 'file:~/app.db', 'file:./data/app.db #old']) {
        const result = writeEnvOnly(dir, dataEnv({ DATABASE_URL: url }));
        expect(result.status, url).toBe(1);
        expect(result.stderr).toContain(`DATABASE_URL=${url}:`);
        expect(result.stderr).toContain('Nothing was written.');
        expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses kept DATABASE_URL / MAIL_OUTBOX_DIR values like that, naming the file', () => {
    const dir = tmpDir('examify-install-kept-value-');
    try {
      writeFile(path.join(dir, '.env'), 'AUTH_MODE=magic-link\nEXAMIFY_DATA_DIR=./data\n');
      for (const line of [
        'DATABASE_URL=file:$HOME/examify.db',
        'MAIL_OUTBOX_DIR=$HOME/outbox',
        'MAIL_OUTBOX_DIR=~/outbox',
      ]) {
        writeFile(path.join(dir, '.env.local'), `${line}\n`);
        const result = writeEnvOnly(dir, dataEnv({ AUTH_MODE: undefined }));
        expect(result.status, line).toBe(1);
        expect(result.stderr).toContain(`.env.local has ${line}, which the app refuses`);
        expect(result.stderr).toContain('Fix it in .env.local');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('install.sh --upgrade of an install configured through .env.local (real data CLI)', () => {
  it('upgrades, moving the family content out, and keeps .env.local as the only env file', async () => {
    const fx = await makeRealFixture();
    try {
      fs.renameSync(path.join(fx.work, '.env'), path.join(fx.work, '.env.local'));
      const envLocal = fs.readFileSync(path.join(fx.work, '.env.local'), 'utf8');
      const result = runReal(fx, fx.work, ['--upgrade', '--yes']);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(git(fx.work, 'rev-parse', 'HEAD')).toBe(fx.upstreamSha);
      expect(result.stdout).toContain('Upgrade complete. [fixture upstream]');
      expect(preUpgradeArchives(fx.dataDir)).toHaveLength(1);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(fx.dataDir, 'content/generated/subjects.json'), 'utf8'),
        ),
      ).toEqual([HISTORY]);
      expect(checkoutLeftovers(fx.work)).toBe('');
      expect(fs.readFileSync(path.join(fx.work, '.env.local'), 'utf8')).toBe(envLocal);
      expect(fs.existsSync(path.join(fx.work, '.env'))).toBe(false);
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  }, 120_000);
});
