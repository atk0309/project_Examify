import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** These capabilities come only from the loopback launcher, never a public config. */
export const SOLO_TRANSPORT_HEADER = 'x-examify-solo-transport';
export const SOLO_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
export const SOLO_LAUNCH_PATTERN = /^([a-f0-9]{64})\.([a-f0-9]{64})$/;

export type SoloBoundaryConfig = {
  SITE_URL: string;
  EXAMIFY_SOLO_TRANSPORT_SECRET?: string;
};

export function isSoloOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      Number(url.port) > 0 &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

export function equalSoloCapability(actual: string, expected: string | undefined): boolean {
  if (!expected || !SOLO_TOKEN_PATTERN.test(expected) || !SOLO_TOKEN_PATTERN.test(actual)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

/** The launcher mints fresh one-use browser links without exposing its signing key. */
export function validSoloLaunchToken(token: string, key: string | undefined): boolean {
  if (!key || !SOLO_TOKEN_PATTERN.test(key)) return false;
  const match = SOLO_LAUNCH_PATTERN.exec(token);
  const nonce = match?.[1];
  const mac = match?.[2];
  if (!nonce || !mac) return false;
  const expected = createHmac('sha256', key).update(nonce).digest('hex');
  return equalSoloCapability(mac, expected);
}

/**
 * Host/Origin do not prove a local socket. The launcher binds BOTH listeners
 * to loopback, checks socket addresses and overwrites this private header.
 * An ordinary `next start` or a direct request to its inner port fails closed.
 * Forwarded/X-Forwarded-* are deliberately never evidence of local access.
 */
export function soloRequestAllowed(
  headers: Pick<Headers, 'get'>,
  config: SoloBoundaryConfig,
  method = 'GET',
): boolean {
  if (!isSoloOrigin(config.SITE_URL)) return false;
  if (
    !equalSoloCapability(
      headers.get(SOLO_TRANSPORT_HEADER) ?? '',
      config.EXAMIFY_SOLO_TRANSPORT_SECRET,
    )
  ) {
    return false;
  }
  if (headers.get('host') !== new URL(config.SITE_URL).host) return false;
  if (headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = headers.get('origin');
  if (origin !== null && origin !== config.SITE_URL) return false;
  if (!['GET', 'HEAD'].includes(method.toUpperCase()) && origin !== config.SITE_URL) {
    return false;
  }
  return true;
}

export function soloCapabilityHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
