import type { AuthMode } from '@/lib/auth-mode';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_MISMATCH } from '@/lib/password-policy';

/**
 * Client-side email shape for first-run `/setup`.
 * Must not be looser than server `z.string().email()` on `bootstrapHouseholdAction`
 * (or invite identity). Spaces, missing `@`, and dot-less domains are refused.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Matches `HOUSEHOLD_NAME_MAX` in `households.ts` (server-only). */
export const SETUP_HOUSEHOLD_NAME_MAX = 80;

/** First-paint `defaultValue` on `/setup`. Not a user/autofill value. */
export const SETUP_DEFAULT_HOUSEHOLD_NAME = 'Our family';

export const SETUP_FIELD_ERROR = {
  householdName: 'Enter a household name.',
  householdNameLong: `Household name must be at most ${SETUP_HOUSEHOLD_NAME_MAX} characters.`,
  setupSecret: 'Enter the setup code for this instance.',
  email: 'Enter a valid email. This is the admin account id.',
  password: `Choose a password of at least ${PASSWORD_MIN_LENGTH} characters.`,
  passwordLong: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
  passwordMismatch: PASSWORD_MISMATCH,
} as const;

export type SetupFormFields = {
  householdName: string;
  setupSecret: string;
  email: string;
  password: string;
  confirmPassword: string;
};

export type SetupFieldKey = keyof SetupFormFields;
export type SetupFieldErrors = Partial<Record<SetupFieldKey, string>>;
export type SetupFieldEdited = Partial<Record<SetupFieldKey, boolean>>;

export const SETUP_FIELD_KEYS = [
  'householdName',
  'setupSecret',
  'email',
  'password',
  'confirmPassword',
] as const satisfies readonly SetupFieldKey[];

export function isSetupEmailValid(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export function readSetupFields(formData: FormData): SetupFormFields {
  return {
    householdName: String(formData.get('householdName') ?? ''),
    setupSecret: String(formData.get('setupSecret') ?? ''),
    email: String(formData.get('email') ?? ''),
    password: String(formData.get('password') ?? ''),
    confirmPassword: String(formData.get('confirmPassword') ?? ''),
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
    if (length < PASSWORD_MIN_LENGTH) {
      errors.password = SETUP_FIELD_ERROR.password;
    } else if (length > PASSWORD_MAX_LENGTH) {
      errors.password = SETUP_FIELD_ERROR.passwordLong;
    } else if (fields.password !== fields.confirmPassword) {
      errors.confirmPassword = SETUP_FIELD_ERROR.passwordMismatch;
    }
  }
  return errors;
}

export function writeSetupFields(form: HTMLFormElement, fields: SetupFormFields): void {
  const assign = (name: keyof SetupFormFields, value: string) => {
    const el = form.elements.namedItem(name);
    if (el instanceof HTMLInputElement) el.value = value;
  };
  assign('householdName', fields.householdName);
  assign('setupSecret', fields.setupSecret);
  assign('email', fields.email);
  assign('password', fields.password);
  assign('confirmPassword', fields.confirmPassword);
}

export function hasSetupFieldErrors(errors: SetupFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

export type SetupBootstrapReason =
  'invalid' | 'already_setup' | 'captcha' | 'rate_limited' | 'forbidden' | 'password_mismatch';

/** Reasons already shown on a field — do not also raise the form banner. */
export function isFieldMappedBootstrapReason(reason: SetupBootstrapReason): boolean {
  return reason === 'invalid' || reason === 'forbidden' || reason === 'password_mismatch';
}

export function setupFieldErrorsFromServer(
  reason: SetupBootstrapReason,
  authMode: AuthMode,
): SetupFieldErrors {
  if (reason === 'forbidden') {
    return { setupSecret: 'That setup code is not valid.' };
  }
  if (reason === 'password_mismatch') {
    return { confirmPassword: SETUP_FIELD_ERROR.passwordMismatch };
  }
  if (reason === 'invalid') {
    return {
      householdName: SETUP_FIELD_ERROR.householdName,
      email: SETUP_FIELD_ERROR.email,
      ...(authMode === 'password' ? { password: SETUP_FIELD_ERROR.password } : {}),
    };
  }
  return {};
}

/**
 * UX lock: a sticky server field error drops on the next successful local
 * edit of that field (or a resubmit, which resets `successfullyEdited`).
 */
export function resolveSetupFieldErrors(input: {
  local: SetupFieldErrors;
  server: SetupFieldErrors;
  successfullyEdited: SetupFieldEdited;
}): SetupFieldErrors {
  const errors: SetupFieldErrors = {};
  for (const key of SETUP_FIELD_KEYS) {
    if (input.local[key]) {
      errors[key] = input.local[key];
      continue;
    }
    if (input.successfullyEdited[key]) continue;
    if (input.server[key]) errors[key] = input.server[key];
  }
  return errors;
}

export function setupFieldsEqual(a: SetupFormFields, b: SetupFormFields): boolean {
  return SETUP_FIELD_KEYS.every((key) => a[key] === b[key]);
}

export function isSetupDefaultHouseholdName(name: string): boolean {
  return name.trim() === SETUP_DEFAULT_HOUSEHOLD_NAME;
}

/** First-paint default name only — must not seed the remount snapshot. */
export function isDefaultOnlySetupSnapshot(fields: SetupFormFields): boolean {
  return (
    (fields.householdName === '' || isSetupDefaultHouseholdName(fields.householdName)) &&
    fields.setupSecret === '' &&
    fields.email === '' &&
    fields.password === '' &&
    fields.confirmPassword === ''
  );
}

/**
 * Silent autofill never fires `input`. Adopt richer live FormData into the
 * remount snapshot. First-paint default household name does not seed it.
 * Password and confirmation are upgrade-only; recover never copies a
 * snapshot password onto an empty live field.
 */
export function captureSilentSetupSnapshot(
  live: SetupFormFields,
  snapshot: SetupFormFields | null,
): SetupFormFields | null {
  if (isDefaultOnlySetupSnapshot(live)) return snapshot;
  if (!snapshot) return live;
  const householdName =
    isSetupDefaultHouseholdName(snapshot.householdName) &&
    !isSetupDefaultHouseholdName(live.householdName)
      ? live.householdName
      : snapshot.householdName || live.householdName;
  return {
    householdName,
    setupSecret: snapshot.setupSecret || live.setupSecret,
    email: snapshot.email || live.email,
    password: snapshot.password || live.password,
    confirmPassword: snapshot.confirmPassword || live.confirmPassword,
  };
}

/**
 * UX lock: if a remount (Turnstile / Script) wipes filled FormData-backed
 * values, restore the snapshot. Default household name is a remount wipe,
 * not a user value. Live password always wins — never resurrect a clear.
 */
export function recoverSetupFieldsAfterRemount(
  live: SetupFormFields,
  snapshot: SetupFormFields | null,
): SetupFormFields {
  if (!snapshot) return live;

  let householdName = live.householdName;
  if (
    (householdName === '' || isSetupDefaultHouseholdName(householdName)) &&
    snapshot.householdName !== '' &&
    !isSetupDefaultHouseholdName(snapshot.householdName)
  ) {
    householdName = snapshot.householdName;
  }

  return {
    householdName,
    setupSecret: live.setupSecret || snapshot.setupSecret,
    email: live.email || snapshot.email,
    password: live.password,
    confirmPassword: live.confirmPassword,
  };
}
