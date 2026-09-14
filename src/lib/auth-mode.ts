/**
 * Auth-mode extension point.
 *
 * The install wizard will later let hosts pick magic-link / passkey / password
 * / SMTP. This PR keeps magic-link as the only implemented mode so we don't
 * half-break sign-in. Household membership (not the auth method) is the
 * access + privacy boundary — new modes should issue the same session shape
 * `{ userId, role, email, studentMode? }` after verifying the person.
 *
 * TODO(multi-auth): read an AUTH_MODE env / settings row here and branch.
 */
export type AuthMode = 'magic-link';

export function getAuthMode(): AuthMode {
  return 'magic-link';
}

export function isMagicLinkEnabled(): boolean {
  return getAuthMode() === 'magic-link';
}
