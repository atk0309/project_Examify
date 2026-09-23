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
 * Stand-in for scripts/examify-data.mjs (Lane B contract): records argv, exits
 * with STUB_EXIT_<COMMAND> when set, and prints the contracted JSON.
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
  process.stderr.write((process.env.STUB_REASON || 'refused') + '\\n');
  process.exit(code);
}
if (cmd === 'paths' && argv.includes('--json')) {
  const dbPath = path.join(dataDir, 'app.db');
  const outboxDir = path.join(dataDir, 'outbox');
  const out = { repoRoot: repo, dataDir, dataDirSource: 'default', dbPath, outboxDir, databaseUrlExplicit: false };
  process.stdout.write(JSON.stringify(out));
} else if (cmd === 'init') {
  fs.mkdirSync(dataDir, { recursive: true });
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
    fs.rmSync(fx.base, { recursive: true, force: true });
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
      expect(init.argv).toEqual(['init', '--repo', fx.work]);
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
        'The family data folder is not safe to use (inside_checkout)',
      );
      expect(summary(fx)).toEqual(['data paths']);
    });
  });

  it('refuses when init reports another owner (exit 5)', () => {
    withFixture({ upstream: false, env: false }, (fx) => {
      const result = runInstaller(fx, [], { STUB_EXIT_INIT: '5' });
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
        'No existing install here (.env is missing); run ./install.sh',
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
      fs.rmSync(fx.base, { recursive: true, force: true });
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
      expect(dataCall(fx, 'backup').argv).toContain('--allow-owner-mismatch');
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
        'data backup',
        'data migrate-checkout',
        'data paths',
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
      expect(migrate.argv).toEqual(['migrate-checkout', '--repo', fx.work]);
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
        'data backup',
        'data migrate-checkout',
        'data paths',
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
      expect(summary(fx)).toEqual(['data backup']);
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
      expect(summary(fx)).toEqual(['data restore', 'pnpm install --frozen-lockfile', 'pnpm build']);
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
      expect(summary(fx)).toEqual(['data restore', 'pnpm install --frozen-lockfile']);
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
