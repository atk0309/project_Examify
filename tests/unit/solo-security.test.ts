import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isSoloOrigin,
  soloRequestAllowed,
  equalSoloCapability,
  validSoloLaunchToken,
} from '@/lib/solo-security';

const secret = '1'.repeat(64);
const config = { SITE_URL: 'http://127.0.0.1:41234', EXAMIFY_SOLO_TRANSPORT_SECRET: secret };
function requestHeaders(values: Record<string, string> = {}) {
  return new Headers({ host: '127.0.0.1:41234', 'x-examify-solo-transport': secret, ...values });
}

describe('solo local request boundary', () => {
  it('accepts only authenticated nonce.mac launch capabilities, never the signing key itself', () => {
    const nonce = '3'.repeat(64);
    const token = nonce + '.' + createHmac('sha256', secret).update(nonce).digest('hex');
    expect(validSoloLaunchToken(token, secret)).toBe(true);
    expect(validSoloLaunchToken(secret, secret)).toBe(false);
    expect(validSoloLaunchToken(token, '4'.repeat(64))).toBe(false);
    expect(validSoloLaunchToken('4' + token.slice(1), secret)).toBe(false);
    expect(validSoloLaunchToken(nonce + '.' + '0'.repeat(64), secret)).toBe(false);
  });
  it('accepts a gateway-authenticated local navigation and exact-origin POST', () => {
    expect(soloRequestAllowed(requestHeaders(), config)).toBe(true);
    expect(soloRequestAllowed(requestHeaders({ origin: config.SITE_URL }), config, 'POST')).toBe(
      true,
    );
  });
  it.each([
    'http://localhost:41234',
    'http://0.0.0.0:41234',
    'http://192.168.0.2:41234',
    'https://127.0.0.1:41234',
    'http://127.0.0.1:41234/path',
    'http://127.0.0.1',
    'http://127.0.0.1:41234/',
    'http://user@127.0.0.1:41234',
  ])('rejects noncanonical origin %s', (origin) => {
    expect(isSoloOrigin(origin)).toBe(false);
  });
  it('rejects direct next start and spoofed forwarding headers', () => {
    const headers = requestHeaders({
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-host': '127.0.0.1:41234',
      'x-real-ip': '127.0.0.1',
    });
    headers.delete('x-examify-solo-transport');
    expect(soloRequestAllowed(headers, config)).toBe(false);
    headers.set('x-examify-solo-transport', '2'.repeat(64));
    expect(soloRequestAllowed(headers, config)).toBe(false);
  });
  it('rejects DNS rebinding Host even with otherwise valid metadata', () => {
    expect(soloRequestAllowed(requestHeaders({ host: 'attacker.example:41234' }), config)).toBe(
      false,
    );
    expect(soloRequestAllowed(requestHeaders({ host: '127.0.0.1:41235' }), config)).toBe(false);
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'requires exact Origin on %s',
    (method) => {
      expect(soloRequestAllowed(requestHeaders(), config, method)).toBe(false);
      expect(
        soloRequestAllowed(requestHeaders({ origin: 'http://127.0.0.1:41235' }), config, method),
      ).toBe(false);
      expect(soloRequestAllowed(requestHeaders({ origin: 'null' }), config, method)).toBe(false);
      expect(soloRequestAllowed(requestHeaders({ origin: config.SITE_URL }), config, method)).toBe(
        true,
      );
    },
  );
  it('rejects cross-site reads and foreign Origins on safe methods', () => {
    expect(soloRequestAllowed(requestHeaders({ 'sec-fetch-site': 'cross-site' }), config)).toBe(
      false,
    );
    expect(soloRequestAllowed(requestHeaders({ origin: 'https://attacker.example' }), config)).toBe(
      false,
    );
  });
  it('never treats missing or malformed capabilities as equal', () => {
    expect(equalSoloCapability('', undefined)).toBe(false);
    expect(equalSoloCapability('1', '1')).toBe(false);
    expect(equalSoloCapability(secret, secret)).toBe(true);
  });
});
