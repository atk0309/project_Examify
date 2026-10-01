import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { proxy } from '@/proxy';

const previous = { ...env };
beforeEach(() =>
  Object.assign(env, {
    EXAMIFY_MODE: 'solo',
    SITE_URL: 'http://127.0.0.1:41234',
    EXAMIFY_SOLO_TRANSPORT_SECRET: '2'.repeat(64),
  }),
);
afterAll(() => Object.assign(env, previous));
function request(path: string, method = 'GET', valid = true) {
  return new NextRequest('http://127.0.0.1:41234' + path, {
    method,
    headers: {
      host: '127.0.0.1:41234',
      origin: 'http://127.0.0.1:41234',
      'x-examify-solo-transport': valid ? '2'.repeat(64) : '',
    },
  });
}
describe('solo all-path proxy', () => {
  it.each(['/', '/solo/start', '/api/health', '/api/solo/session', '/_next/static/file.js'])(
    'requires launcher transport on %s',
    (path) => {
      expect(proxy(request(path, 'GET', false)).status).toBe(403);
      expect(proxy(request(path)).status).toBe(200);
    },
  );
  it.each(['/signin', '/setup', '/invite/token', '/signin/verify'])(
    'closes household entry route %s',
    (path) => {
      expect(proxy(request(path)).headers.get('location')).toBe(
        'http://127.0.0.1:41234/solo/start',
      );
      expect(proxy(request(path, 'POST')).status).toBe(403);
    },
  );
  it('does not apply local launcher policy to authenticated household installations', () => {
    env.EXAMIFY_MODE = 'household';
    expect(proxy(request('/signin', 'POST', false)).status).toBe(200);
  });
});
