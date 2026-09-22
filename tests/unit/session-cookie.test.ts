import { afterEach, describe, expect, it, vi } from 'vitest';

type CookieWrite = { name: string; value: string; options: Record<string, unknown> };

// A `cookies()`-shaped store so the real iron-session writes land here.
const jar = vi.hoisted(() => ({
  values: new Map<string, string>(),
  writes: [] as CookieWrite[],
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.values.get(name);
      return value === undefined ? undefined : { name, value };
    },
    getAll: () => [...jar.values].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      jar.writes.push({ name, value, options });
      if (options.maxAge === 0) jar.values.delete(name);
      else jar.values.set(name, value);
    },
  }),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT:${url}`), { url });
  },
}));

const ORIGINAL = {
  SITE_URL: process.env.SITE_URL,
  SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME,
};

function restoreEnv(key: keyof typeof ORIGINAL, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else Reflect.set(process.env, key, value);
}

/** Fresh env + auth modules so the module-level cookie options re-derive. */
async function loadAuthFor(siteUrl: string, cookieName?: string) {
  vi.resetModules();
  restoreEnv('SITE_URL', siteUrl);
  restoreEnv('SESSION_COOKIE_NAME', cookieName);
  jar.values.clear();
  jar.writes.length = 0;
  return import('@/lib/auth');
}

afterEach(() => {
  restoreEnv('SITE_URL', ORIGINAL.SITE_URL);
  restoreEnv('SESSION_COOKIE_NAME', ORIGINAL.SESSION_COOKIE_NAME);
  vi.resetModules();
});

describe('session cookie follows SITE_URL (iron-session wiring)', () => {
  it('sets and clears a non-Secure examify_session cookie on a plain-http LAN host', async () => {
    const { getRawSession, destroySession } = await loadAuthFor('http://192.168.1.20:3000');
    const session = await getRawSession();
    session.userId = 1;
    session.role = 'student';
    await session.save();

    expect(jar.writes).toHaveLength(1);
    expect(jar.writes[0]).toMatchObject({
      name: 'examify_session',
      options: { secure: false, httpOnly: true, sameSite: 'lax', path: '/' },
    });
    expect(jar.writes[0]?.value).not.toBe('');

    await destroySession();
    expect(jar.writes.at(-1)).toMatchObject({
      name: 'examify_session',
      value: '',
      options: { secure: false, maxAge: 0, path: '/' },
    });
    expect(jar.values.has('examify_session')).toBe(false);
  });

  it('sets a Secure __Host- cookie on an https SITE_URL and signOut clears that same cookie', async () => {
    const { getRawSession } = await loadAuthFor('https://exam.example.com');
    const session = await getRawSession();
    session.userId = 1;
    session.role = 'parent';
    await session.save();
    expect(jar.writes[0]).toMatchObject({
      name: '__Host-examify_session',
      options: { secure: true, path: '/' },
    });

    const { signOut } = await import('@/actions/signOut');
    await expect(signOut()).rejects.toMatchObject({ url: '/signin' });
    expect(jar.writes.at(-1)).toMatchObject({
      name: '__Host-examify_session',
      value: '',
      options: { secure: true, maxAge: 0 },
    });
    expect(jar.values.size).toBe(0);
  });

  it('keeps an explicit SESSION_COOKIE_NAME and /signin/invalidate clears it', async () => {
    const { getRawSession } = await loadAuthFor('http://nas.local:3000', 'family_exam');
    const session = await getRawSession();
    session.userId = 7;
    session.role = 'student';
    await session.save();
    expect(jar.writes[0]).toMatchObject({ name: 'family_exam', options: { secure: false } });

    const { GET } = await import('@/app/signin/invalidate/route');
    await expect(GET()).rejects.toMatchObject({ url: '/signin' });
    expect(jar.writes.at(-1)).toMatchObject({
      name: 'family_exam',
      value: '',
      options: { secure: false, maxAge: 0 },
    });
    expect(jar.values.has('family_exam')).toBe(false);
  });
});
