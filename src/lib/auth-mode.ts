/**
 * Auth-mode extension point.
 *
 * The host picks a mode at install (`AUTH_MODE` in env, written by `install.sh`)
 * or by editing `.env` and restarting. Household membership (not the auth
 * method) is the access + privacy boundary — every mode issues the same
 * session shape `{ userId, role, email, studentMode? }` after verifying the
 * person.
 *
 * - `password` — email + password; no mail delivery required
 * - `magic-link` — one-time URL via Resend, SMTP, or the local outbox
 * - `local-otp` — one-time 6-digit code written to the outbox (and emailed
 *   when a transport is configured). Production requires ALLOW_LOCAL_OUTBOX.
 */
export const AUTH_MODES = ['password', 'magic-link', 'local-otp'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const MAIL_TRANSPORTS = ['auto', 'resend', 'smtp', 'outbox'] as const;
export type MailTransportSetting = (typeof MAIL_TRANSPORTS)[number];
export type ResolvedMailTransport = 'resend' | 'smtp' | 'outbox';

export function parseAuthMode(value: unknown): AuthMode | undefined {
  if (value === 'password' || value === 'magic-link' || value === 'local-otp') return value;
  return undefined;
}

/** Returns a supported auth mode, defaulting unknown values to magic-link. */
export function resolveAuthMode(value: unknown): AuthMode {
  return parseAuthMode(value) ?? 'magic-link';
}

export function parseMailTransport(value: unknown): MailTransportSetting | undefined {
  if (value === 'auto' || value === 'resend' || value === 'smtp' || value === 'outbox') {
    return value;
  }
  return undefined;
}

export function isPasswordAuth(mode: AuthMode): boolean {
  return mode === 'password';
}

export function usesEmailChallenge(mode: AuthMode): boolean {
  return mode === 'magic-link' || mode === 'local-otp';
}

export function usesLocalOtp(mode: AuthMode): boolean {
  return mode === 'local-otp';
}

export function usesMagicLink(mode: AuthMode): boolean {
  return mode === 'magic-link';
}

/**
 * Local OTP bearers are stored hashed as `otp:{email}:{role}:{code}`.
 * `/signin/verify` must never accept these — they are only consumed by
 * `verifyLocalOtp` (with the per-challenge guess lock).
 */
export function isOtpShapedBearer(token: string): boolean {
  return token.trim().startsWith('otp:');
}
