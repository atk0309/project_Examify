import 'server-only';

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

function isValidIp(value: string): boolean {
  return IPV4.test(value) || (value.includes(':') && IPV6.test(value));
}

/**
 * Resolve the client IP from headers added by the trusted reverse proxy.
 *
 * Trust order:
 *
 *   1. `cf-connecting-ip` — Cloudflare-injected, opaque to the client. Use it
 *      when Cloudflare fronts the app.
 *   2. `x-real-ip` — typically set by Nginx-style reverse proxies and not
 *      appendable by the client.
 *   3. The **last** entry of `x-forwarded-for` — the value the immediate
 *      trusted proxy appended. The *first* entry of XFF is the original
 *      client's claim and can be spoofed by setting the header from the
 *      browser; trusting it lets an attacker rotate IPs to bypass the
 *      sliding-window rate limits in `lib/rate-limit.ts`.
 *   4. `0.0.0.0` — surfaced as "unknown" so the rate limiter still applies a
 *      shared cap rather than silently letting the request through.
 *
 * This assumes a single trusted proxy hop. If you front the app with N>1
 * proxies you need to skip the rightmost N-1 entries of XFF.
 */
export function extractClientIp(headers: Headers): string {
  const cf = headers.get('cf-connecting-ip');
  if (cf && isValidIp(cf.trim())) return cf.trim();

  const real = headers.get('x-real-ip');
  if (real && isValidIp(real.trim())) return real.trim();

  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const last = hops[hops.length - 1];
    if (last && isValidIp(last)) return last;
  }

  return '0.0.0.0';
}
