/** Shared password length bounds — client-safe (no Node crypto). */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

/** Shown when the two password fields differ. Not a server enumeration signal. */
export const PASSWORD_MISMATCH = 'Those passwords do not match.';
