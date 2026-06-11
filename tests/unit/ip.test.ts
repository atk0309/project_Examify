import { describe, expect, it } from 'vitest';
import { extractClientIp } from '@/lib/ip';

function h(record: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(record)) headers.set(k, v);
  return headers;
}

describe('extractClientIp', () => {
  it('takes the last (proxy-added) hop from x-forwarded-for', () => {
    expect(extractClientIp(h({ 'x-forwarded-for': '203.0.113.4, 10.0.0.1' }))).toBe('10.0.0.1');
  });

  it('ignores a client-spoofed prefix in x-forwarded-for', () => {
    // Attacker prepends `1.1.1.1` to spoof their IP; the trusted proxy then
    // appends the real connecting peer at `198.51.100.7`.
    expect(extractClientIp(h({ 'x-forwarded-for': '1.1.1.1, 198.51.100.7' }))).toBe('198.51.100.7');
  });

  it('prefers cf-connecting-ip over x-forwarded-for', () => {
    expect(
      extractClientIp(
        h({
          'x-forwarded-for': 'spoofed.bad, 1.2.3.4',
          'cf-connecting-ip': '198.51.100.7',
        }),
      ),
    ).toBe('198.51.100.7');
  });

  it('prefers x-real-ip over x-forwarded-for when cf-connecting-ip is absent', () => {
    expect(
      extractClientIp(
        h({
          'x-forwarded-for': '203.0.113.4, 10.0.0.1',
          'x-real-ip': '192.0.2.9',
        }),
      ),
    ).toBe('192.0.2.9');
  });

  it('falls back to x-forwarded-for when cf-connecting-ip and x-real-ip are absent', () => {
    expect(extractClientIp(h({ 'x-forwarded-for': '198.51.100.7' }))).toBe('198.51.100.7');
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
