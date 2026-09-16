import type { AuthMode } from '@/lib/auth-mode';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/password-policy';

/**
 * Client-side email shape for first-run `/setup`.
 * Must not be looser than server `z.string().email()` on `bootstrapHouseholdAction`
 * (or invite identity). Spaces, missing `@`, and dot-less domains are refused.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Matches `HOUSEHOLD_NAME_MAX` in `households.ts` (server-only). */
export const SETUP_HOUSEHOLD_NAME_MAX = 80;

export const SETUP_FIELD_ERROR = {
  householdName: 'Enter a household name.',
  householdNameLong: 'Household name is too long.',
  setupSecret: 'Enter the setup code for this instance.',
  email: 'Enter a valid email. This is the admin account id.',
  password: `Choose a password of at least ${PASSWORD_MIN_LENGTH} characters.`,
} as const;

export type SetupFormFields = {
  householdName: string;
  setupSecret: string;
  email: string;
  password: string;
};

export type SetupFieldKey = keyof SetupFormFields;
export type SetupFieldErrors = Partial<Record<SetupFieldKey, string>>;

export function isSetupEmailValid(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export function readSetupFields(formData: FormData): SetupFormFields {
  return {
    householdName: String(formData.get('householdName') ?? ''),
    setupSecret: String(formData.get('setupSecret') ?? ''),
    email: String(formData.get('email') ?? ''),
    password: String(formData.get('password') ?? ''),
  };
}

export function validateSetupFields(fields: SetupFormFields, authMode: AuthMode): SetupFieldErrors {
  const errors: SetupFieldErrors = {};
  const name = fields.householdName.trim();
  if (!name) {
    errors.householdName = SETUP_FIELD_ERROR.householdName;
  } else if (name.length > SETUP_HOUSEHOLD_NAME_MAX) {
    errors.householdName = SETUP_FIELD_ERROR.householdNameLong;
  }
  if (!fields.setupSecret.trim()) {
    errors.setupSecret = SETUP_FIELD_ERROR.setupSecret;
  }
  if (!isSetupEmailValid(fields.email)) {
    errors.email = SETUP_FIELD_ERROR.email;
  }
  if (authMode === 'password') {
    const length = fields.password.length;
    if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
      errors.password = SETUP_FIELD_ERROR.password;
    }
  }
  return errors;
}

export function hasSetupFieldErrors(errors: SetupFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function setupFieldErrorsFromServer(
  reason: 'invalid' | 'already_setup' | 'captcha' | 'rate_limited' | 'forbidden',
): SetupFieldErrors {
  if (reason === 'forbidden') {
    return { setupSecret: 'That setup code is not valid.' };
  }
  if (reason === 'invalid') {
    return {
      householdName: SETUP_FIELD_ERROR.householdName,
      email: SETUP_FIELD_ERROR.email,
    };
  }
  return {};
}
