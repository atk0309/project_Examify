import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from '@/lib/captcha';
import { env } from '@/lib/env';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifyTurnstile dummy-secret shortcuts', () => {
  const original = env.TURNSTILE_SECRET_KEY;
  afterEach(() => {
    (env as { TURNSTILE_SECRET_KEY: string }).TURNSTILE_SECRET_KEY = original;
  });

  it('always-pass dummy secret returns ok=true without a network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    (env as { TURNSTILE_SECRET_KEY: string }).TURNSTILE_SECRET_KEY =
      '1x0000000000000000000000000000000AA';
    const result = await verifyTurnstile('any-token', '1.2.3.4');
    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('always-fail dummy secret returns ok=false without a network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    (env as { TURNSTILE_SECRET_KEY: string }).TURNSTILE_SECRET_KEY =
      '2x0000000000000000000000000000000AA';
    const result = await verifyTurnstile('any-token', '1.2.3.4');
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain('always-fails-dummy-secret');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('token-spent dummy secret returns ok=false without a network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    (env as { TURNSTILE_SECRET_KEY: string }).TURNSTILE_SECRET_KEY =
      '3x0000000000000000000000000000000AA';
    const result = await verifyTurnstile('any-token', '1.2.3.4');
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain('timeout-or-duplicate-dummy-secret');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('missing token still short-circuits before checking the secret', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    (env as { TURNSTILE_SECRET_KEY: string }).TURNSTILE_SECRET_KEY =
      '1x0000000000000000000000000000000AA';
    const result = await verifyTurnstile('', '1.2.3.4');
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain('missing-input-response');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('verifyTurnstile', () => {
  it('returns ok=true when Cloudflare reports success', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const result = await verifyTurnstile('test-token', '203.0.113.4');
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(VERIFY_URL, expect.objectContaining({ method: 'POST' }));
    const body = fetchSpy.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get('response')).toBe('test-token');
    expect(body.get('remoteip')).toBe('203.0.113.4');
  });

  it('returns ok=false with error-codes when Cloudflare reports failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
        status: 200,
      }),
    );
    const result = await verifyTurnstile('bad', '203.0.113.4');
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain('invalid-input-response');
  });

  it('returns ok=false on HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const result = await verifyTurnstile('x', '1.2.3.4');
    expect(result.ok).toBe(false);
    expect(result.errorCodes?.[0]).toContain('http-500');
  });

  it('short-circuits on missing token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await verifyTurnstile('', '1.2.3.4');
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
