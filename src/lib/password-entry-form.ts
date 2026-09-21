import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { EMAIL_RE } from '@/lib/setup-form';

/**
 * Client-side shape for password sign-in and the invite password step.
 * Same email pipe as `SetupForm` / server `z.string().email()`.
 * Sign-in does not apply the invite minimum length: a wrong (including
 * short) password stays a single server `invalid`.
 */
export function isPasswordEntryEmailValid(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export const SIGN_IN_FIELD_ERROR = {
  email: 'Enter a valid email address.',
  password: 'Enter your password.',
  passwordLong: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
} as const;

export const INVITE_PASSWORD_FIELD_ERROR = {
  email: 'Enter a valid email address.',
  password: `Choose a password of at least ${PASSWORD_MIN_LENGTH} characters.`,
  passwordLong: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
} as const;

export type PasswordEntryFields = {
  email: string;
  password: string;
};

export type PasswordEntryFieldKey = keyof PasswordEntryFields;
export type PasswordEntryFieldErrors = Partial<Record<PasswordEntryFieldKey, string>>;

export function readPasswordEntryFields(formData: FormData): PasswordEntryFields {
  return {
    email: String(formData.get('email') ?? ''),
    password: String(formData.get('password') ?? ''),
  };
}

/** Sign-in: non-empty password, max length. Empty React state must not block submit. */
export function validateSignInFields(fields: PasswordEntryFields): PasswordEntryFieldErrors {
  const errors: PasswordEntryFieldErrors = {};
  if (!isPasswordEntryEmailValid(fields.email)) {
    errors.email = SIGN_IN_FIELD_ERROR.email;
  }
  const length = fields.password.length;
  if (length < 1) {
    errors.password = SIGN_IN_FIELD_ERROR.password;
  } else if (length > PASSWORD_MAX_LENGTH) {
    errors.password = SIGN_IN_FIELD_ERROR.passwordLong;
  }
  return errors;
}

/**
 * Invite password step only. A short password is a field error here so the
 * CTA is not the only signal. Membership still waits for `completePasswordInvite`.
 */
export function validateInvitePasswordFields(
  fields: PasswordEntryFields,
): PasswordEntryFieldErrors {
  const errors: PasswordEntryFieldErrors = {};
  if (!isPasswordEntryEmailValid(fields.email)) {
    errors.email = INVITE_PASSWORD_FIELD_ERROR.email;
  }
  const length = fields.password.length;
  if (length < PASSWORD_MIN_LENGTH) {
    errors.password = INVITE_PASSWORD_FIELD_ERROR.password;
  } else if (length > PASSWORD_MAX_LENGTH) {
    errors.password = INVITE_PASSWORD_FIELD_ERROR.passwordLong;
  }
  return errors;
}

export function hasPasswordEntryFieldErrors(errors: PasswordEntryFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}
