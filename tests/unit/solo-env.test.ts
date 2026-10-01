import { describe, expect, it } from 'vitest';
import { parseEnv, sessionCookieConfig } from '@/lib/env';

const base: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  EXAMIFY_MODE: 'solo',
  SITE_URL: 'http://127.0.0.1:41234',
  EXAMIFY_DATA_DIR: 'tests/.tmp/solo-env',
  AUTH_SECRET: 'private-test-auth-secret-at-least-32-characters',
  EXAMIFY_SOLO_LAUNCH_TOKEN: '1'.repeat(64),
  EXAMIFY_SOLO_TRANSPORT_SECRET: '2'.repeat(64),
};

describe('explicit solo configuration', () => {
  it('defaults existing installations to household mode', () => {
    expect(parseEnv({ NODE_ENV: 'test' }).EXAMIFY_MODE).toBe('household');
  });
  it('accepts a fully launcher-configured profile with a separate strict-mode cookie name', () => {
    const env = parseEnv(base);
    expect(env.EXAMIFY_MODE).toBe('solo');
    expect(sessionCookieConfig(env)).toEqual({
      name: expect.stringMatching(/^examify_solo_session_[a-f0-9]{16}$/),
      secure: false,
    });
  });
  it.each([
    'EXAMIFY_SOLO_LAUNCH_TOKEN',
    'EXAMIFY_SOLO_TRANSPORT_SECRET',
    'EXAMIFY_DATA_DIR',
    'AUTH_SECRET',
  ])('fails closed when %s is absent', (key) => {
    expect(() => parseEnv({ ...base, [key]: undefined })).toThrow();
  });
  it('rejects shared capability, remote exposure, legacy import and unknown mode', () => {
    expect(() =>
      parseEnv({ ...base, EXAMIFY_SOLO_TRANSPORT_SECRET: base.EXAMIFY_SOLO_LAUNCH_TOKEN }),
    ).toThrow();
    expect(() => parseEnv({ ...base, SITE_URL: 'https://examify.example' })).toThrow();
    expect(() => parseEnv({ ...base, FAMILIES: '[{}]' })).toThrow();
    expect(() => parseEnv({ ...base, EXAMIFY_MODE: 'remote' })).toThrow();
  });
});
