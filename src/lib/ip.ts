import 'server-only';
import { env, type ClientIpHeader } from './env';

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

function isValidIp(value: string): boolean {
  return IPV4.test(value) || (value.includes(':') && IPV6.test(value));
}

/** The rightmost X-Forwarded-For entry when it is a valid IP, else null. */
function lastForwardedFor(headers: Headers): string | null {
  const xff = headers.get('x-forwarded-for');
  if (!xff) return null;
  const hops = xff
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const last = hops[hops.length - 1];
  return last && isValidIp(last) ? last : null;
}

/**
 * Resolve the client IP for the rate limiter from the one header the host
 * says its proxy controls (`CLIENT_IP_HEADER`). Every other client-IP header
 * is ignored: `cf-connecting-ip` and `x-real-ip` are plain request headers
 * that a client can send itself, and most proxies (nginx, Caddy) pass a
 * client-sent value through untouched. Trusting one the edge does not
 * overwrite lets an attacker rotate "IPs" per request and walk straight past
 * the per-IP buckets in `lib/rate-limit.ts`.
 *
 *   - `x-forwarded-for` (default) — the **last** entry, i.e. the peer the
 *     nearest trusted proxy appended. The first entries are the client's
 *     own claim. Right for any single reverse proxy that appends to XFF
 *     (Caddy, Traefik, nginx `proxy_add_x_forwarded_for`, most PaaS edges).
 *     `next start` only fills XFF when it is absent, so a server exposed
 *     with no proxy in front trusts whatever the client sends.
 *   - `x-real-ip` — only when your proxy *overwrites* it with the peer
 *     address (nginx `proxy_set_header X-Real-IP $remote_addr;`).
 *   - `cf-connecting-ip` — only when the origin is reachable **exclusively**
 *     through Cloudflare (a Cloudflare Tunnel, or a firewall that admits
 *     Cloudflare's ranges only). Otherwise anyone who finds the origin can
 *     set it.
 *
 * X-Forwarded-For is parsed only in `x-forwarded-for` mode. When the
 * configured header is absent or not a valid IP, the result is `0.0.0.0`,
 * never XFF: a host picks `x-real-ip` / `cf-connecting-ip` precisely because
 * XFF stays client-controlled there, so falling back to it would reopen the
 * rotation bypass. `0.0.0.0` is surfaced as "unknown" so the limiter still
 * applies one shared cap instead of letting the request through. In XFF mode
 * an invalid last entry is not skipped (anything to its left is
 * client-controlled).
 *
 * This assumes a single trusted proxy hop. If you front the app with N>1
 * proxies you need to skip the rightmost N-1 entries of XFF.
 */
export function extractClientIp(
  headers: Headers,
  mode: ClientIpHeader = env.CLIENT_IP_HEADER,
): string {
  if (mode !== 'x-forwarded-for') {
    const value = headers.get(mode)?.trim();
    return value && isValidIp(value) ? value : '0.0.0.0';
  }
  return lastForwardedFor(headers) ?? '0.0.0.0';
}
