import 'server-only';
import { env } from './env';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Cloudflare's documented dummy server-side secrets. When the configured
 * secret matches one of these, we return the documented behaviour locally
 * instead of calling out to siteverify — the test/CI runner may not have
 * outbound access to challenges.cloudflare.com, and the answer is fixed by
 * Cloudflare regardless of the response token anyway.
 *
 * Reference: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
const DUMMY_SECRETS = {
  '1x0000000000000000000000000000000AA': { ok: true },
  '2x0000000000000000000000000000000AA': {
    ok: false,
    errorCodes: ['always-fails-dummy-secret'],
  },
  '3x0000000000000000000000000000000AA': {
    ok: false,
    errorCodes: ['timeout-or-duplicate-dummy-secret'],
  },
} satisfies Record<string, TurnstileResult>;

export type TurnstileResult = {
  ok: boolean;
  errorCodes?: string[];
};

export async function verifyTurnstile(token: string, ip: string): Promise<TurnstileResult> {
  if (!token) return { ok: false, errorCodes: ['missing-input-response'] };

  const dummy = (DUMMY_SECRETS as Record<string, TurnstileResult>)[env.TURNSTILE_SECRET_KEY];
  if (dummy) return dummy;

  const body = new URLSearchParams();
  body.set('secret', env.TURNSTILE_SECRET_KEY);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);

  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      body,
      // Turnstile may take a moment under load.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { ok: false, errorCodes: [`http-${res.status}`] };
    }
    const data = (await res.json()) as { success?: boolean; ['error-codes']?: string[] };
    return {
      ok: data.success === true,
      errorCodes: data['error-codes'],
    };
  } catch (error) {
    return { ok: false, errorCodes: [error instanceof Error ? error.message : 'unknown'] };
  }
}
