import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from '@/lib/captcha';
import { env } from '@/lib/env';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifyTurnstile dummy-secret shortcuts', () => {
  const original = env.TURNSTILE_SECRET_KEY;
  const originalSite = env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const originalEnabled = env.TURNSTILE_ENABLED;
  afterEach(() => {
    (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = original;
    (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY =
      originalSite;
    (env as { TURNSTILE_ENABLED?: boolean }).TURNSTILE_ENABLED = originalEnabled;
  });

  function enableCaptcha(secret: string, site = '1x00000000000000000000AA') {
    (env as { TURNSTILE_ENABLED: boolean }).TURNSTILE_ENABLED = true;
    (env as { TURNSTILE_SECRET_KEY: string }).TURNSTILE_SECRET_KEY = secret;
    (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY = site;
  }

  it('always-pass dummy secret returns ok=true without a network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    enableCaptcha('1x0000000000000000000000000000000AA');
    const result = await verifyTurnstile('any-token', '1.2.3.4');
    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('always-fail dummy secret returns ok=false without a network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    enableCaptcha('2x0000000000000000000000000000000AA');
    const result = await verifyTurnstile('any-token', '1.2.3.4');
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain('always-fails-dummy-secret');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('token-spent dummy secret returns ok=false without a network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    enableCaptcha('3x0000000000000000000000000000000AA');
    const result = await verifyTurnstile('any-token', '1.2.3.4');
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain('timeout-or-duplicate-dummy-secret');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects when enabled but exactly one Turnstile key is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    (env as { TURNSTILE_ENABLED: boolean }).TURNSTILE_ENABLED = true;
    (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY =
      '1x0000000000000000000000000000000AA';
    (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY = undefined;
    const result = await verifyTurnstile('any-token', '1.2.3.4');
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain('partial-turnstile-config');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is skipped when TURNSTILE_ENABLED is unset even if keys are present', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { isTurnstileEnabled } = await import('@/lib/env');
    (env as { TURNSTILE_ENABLED?: boolean }).TURNSTILE_ENABLED = undefined;
    (env as { TURNSTILE_SECRET_KEY: string }).TURNSTILE_SECRET_KEY =
      '1x0000000000000000000000000000000AA';
    (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY =
      '1x00000000000000000000AA';
    expect(isTurnstileEnabled()).toBe(false);
    const result = await verifyTurnstile('', '1.2.3.4');
    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is skipped entirely when both Turnstile keys are unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { isTurnstileEnabled } = await import('@/lib/env');
    (env as { TURNSTILE_ENABLED?: boolean }).TURNSTILE_ENABLED = undefined;
    (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = undefined;
    (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY = undefined;
    expect(isTurnstileEnabled()).toBe(false);
    const result = await verifyTurnstile('', '1.2.3.4');
    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('missing token still short-circuits before checking the secret', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    enableCaptcha('1x0000000000000000000000000000000AA');
    const result = await verifyTurnstile('', '1.2.3.4');
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain('missing-input-response');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('verifyTurnstile', () => {
  const original = env.TURNSTILE_SECRET_KEY;
  const originalSite = env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const originalEnabled = env.TURNSTILE_ENABLED;
  afterEach(() => {
    (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = original;
    (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY =
      originalSite;
    (env as { TURNSTILE_ENABLED?: boolean }).TURNSTILE_ENABLED = originalEnabled;
  });

  function enableLiveCaptcha() {
    (env as { TURNSTILE_ENABLED: boolean }).TURNSTILE_ENABLED = true;
    (env as { TURNSTILE_SECRET_KEY: string }).TURNSTILE_SECRET_KEY =
      'unit-test-secret-not-a-cloudflare-dummy-12';
    (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY =
      '1x00000000000000000000AA';
  }

  it('returns ok=true when Cloudflare reports success', async () => {
    enableLiveCaptcha();
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
    enableLiveCaptcha();
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
    enableLiveCaptcha();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const result = await verifyTurnstile('x', '1.2.3.4');
    expect(result.ok).toBe(false);
    expect(result.errorCodes?.[0]).toContain('http-500');
  });

  it('short-circuits on missing token when captcha is enabled', async () => {
    enableLiveCaptcha();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await verifyTurnstile('', '1.2.3.4');
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
