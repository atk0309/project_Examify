import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env, parseEnv } from '@/lib/env';
import { extractClientIp } from '@/lib/ip';

function h(record: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(record)) headers.set(k, v);
  return headers;
}

const setMode = (mode: typeof env.CLIENT_IP_HEADER) => {
  (env as { CLIENT_IP_HEADER: typeof env.CLIENT_IP_HEADER }).CLIENT_IP_HEADER = mode;
};

// Pin the default so a CLIENT_IP_HEADER in the developer's shell cannot leak in.
beforeEach(() => setMode('x-forwarded-for'));
afterEach(() => setMode('x-forwarded-for'));

describe('extractClientIp (default: x-forwarded-for)', () => {
  it('defaults to the x-forwarded-for mode', () => {
    expect(parseEnv({ NODE_ENV: 'test' }).CLIENT_IP_HEADER).toBe('x-forwarded-for');
  });

  it('takes the last (proxy-added) hop from x-forwarded-for', () => {
    expect(extractClientIp(h({ 'x-forwarded-for': '203.0.113.4, 10.0.0.1' }))).toBe('10.0.0.1');
  });

  it('ignores a client-spoofed prefix in x-forwarded-for', () => {
    // Attacker prepends `1.1.1.1` to spoof their IP; the trusted proxy then
    // appends the real connecting peer at `198.51.100.7`.
    expect(extractClientIp(h({ 'x-forwarded-for': '1.1.1.1, 198.51.100.7' }))).toBe('198.51.100.7');
  });

  it('ignores a spoofed cf-connecting-ip unless it is configured', () => {
    expect(
      extractClientIp(
        h({
          'x-forwarded-for': '203.0.113.4, 10.0.0.1',
          'cf-connecting-ip': '198.51.100.7',
        }),
      ),
    ).toBe('10.0.0.1');
  });

  it('ignores a spoofed x-real-ip unless it is configured', () => {
    expect(
      extractClientIp(
        h({
          'x-forwarded-for': '203.0.113.4, 10.0.0.1',
          'x-real-ip': '192.0.2.9',
        }),
      ),
    ).toBe('10.0.0.1');
  });

  it('does not let rotating cf-connecting-ip / x-real-ip values split the bucket', () => {
    const seen = new Set(
      ['192.0.2.1', '192.0.2.2', '192.0.2.3'].map((spoof) =>
        extractClientIp(h({ 'cf-connecting-ip': spoof, 'x-real-ip': spoof })),
      ),
    );
    expect([...seen]).toEqual(['0.0.0.0']);
  });

  it('returns 0.0.0.0 when no header is present', () => {
    expect(extractClientIp(h({}))).toBe('0.0.0.0');
  });

  it('rejects non-IP values silently', () => {
    expect(extractClientIp(h({ 'x-forwarded-for': 'not-an-ip' }))).toBe('0.0.0.0');
  });

  it('rejects when the last XFF entry is invalid even if an earlier one looks valid', () => {
    expect(extractClientIp(h({ 'x-forwarded-for': '198.51.100.7, not-an-ip' }))).toBe('0.0.0.0');
  });

  it('accepts IPv6', () => {
    expect(extractClientIp(h({ 'x-forwarded-for': '2001:db8::1' }))).toBe('2001:db8::1');
  });
});

describe('extractClientIp (x-real-ip)', () => {
  it('reads x-real-ip over x-forwarded-for', () => {
    expect(
      extractClientIp(
        h({ 'x-forwarded-for': '203.0.113.4, 10.0.0.1', 'x-real-ip': '192.0.2.9' }),
        'x-real-ip',
      ),
    ).toBe('192.0.2.9');
  });

  it('still ignores cf-connecting-ip', () => {
    expect(
      extractClientIp(
        h({ 'cf-connecting-ip': '198.51.100.7', 'x-real-ip': '192.0.2.9' }),
        'x-real-ip',
      ),
    ).toBe('192.0.2.9');
    expect(extractClientIp(h({ 'cf-connecting-ip': '198.51.100.7' }), 'x-real-ip')).toBe('0.0.0.0');
  });

  it('falls back to the last XFF hop when x-real-ip is absent or invalid', () => {
    expect(extractClientIp(h({ 'x-forwarded-for': '203.0.113.4, 10.0.0.1' }), 'x-real-ip')).toBe(
      '10.0.0.1',
    );
    expect(
      extractClientIp(
        h({ 'x-forwarded-for': '203.0.113.4, 10.0.0.1', 'x-real-ip': 'unknown' }),
        'x-real-ip',
      ),
    ).toBe('10.0.0.1');
    expect(extractClientIp(h({ 'x-real-ip': 'unknown' }), 'x-real-ip')).toBe('0.0.0.0');
  });

  it('is picked up from env when no mode is passed', () => {
    setMode('x-real-ip');
    expect(extractClientIp(h({ 'x-forwarded-for': '10.0.0.1', 'x-real-ip': '192.0.2.9' }))).toBe(
      '192.0.2.9',
    );
  });
});

describe('extractClientIp (cf-connecting-ip)', () => {
  it('reads cf-connecting-ip over x-forwarded-for', () => {
    expect(
      extractClientIp(
        h({ 'x-forwarded-for': '203.0.113.4, 10.0.0.1', 'cf-connecting-ip': '198.51.100.7' }),
        'cf-connecting-ip',
      ),
    ).toBe('198.51.100.7');
  });

  it('still ignores x-real-ip', () => {
    expect(extractClientIp(h({ 'x-real-ip': '192.0.2.9' }), 'cf-connecting-ip')).toBe('0.0.0.0');
  });

  it('falls back to the last XFF hop when cf-connecting-ip is absent or invalid', () => {
    expect(extractClientIp(h({ 'x-forwarded-for': '10.0.0.1' }), 'cf-connecting-ip')).toBe(
      '10.0.0.1',
    );
    expect(
      extractClientIp(
        h({ 'x-forwarded-for': '10.0.0.1', 'cf-connecting-ip': 'bogus' }),
        'cf-connecting-ip',
      ),
    ).toBe('10.0.0.1');
  });

  it('is picked up from env when no mode is passed', () => {
    setMode('cf-connecting-ip');
    expect(
      extractClientIp(h({ 'x-forwarded-for': '10.0.0.1', 'cf-connecting-ip': '2001:db8::7' })),
    ).toBe('2001:db8::7');
  });
});
