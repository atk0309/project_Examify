import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import {
  hasPasswordEntryFieldErrors,
  INVITE_PASSWORD_FIELD_ERROR,
  isPasswordEntryEmailValid,
  readPasswordEntryFields,
  SIGN_IN_FIELD_ERROR,
  validateInvitePasswordFields,
  validateSignInFields,
} from '@/lib/password-entry-form';
import { EMAIL_RE } from '@/lib/setup-form';

const serverEmail = z.string().trim().toLowerCase().email();

describe('password entry fields', () => {
  it('reads DOM FormData so autofill without React onChange is still visible', () => {
    const data = new FormData();
    data.set('email', 'autofill@example.com');
    data.set('password', 'admin-password');
    data.set('role', 'parent');
    expect(readPasswordEntryFields(data)).toEqual({
      email: 'autofill@example.com',
      password: 'admin-password',
    });
  });

  it('keeps the email check aligned with SetupForm and not looser than z.email()', () => {
    expect(isPasswordEntryEmailValid('host@example.com')).toBe(EMAIL_RE.test('host@example.com'));
    expect(isPasswordEntryEmailValid('not-an-email')).toBe(false);
    expect(serverEmail.safeParse('host@example.com').success).toBe(true);
    expect(isPasswordEntryEmailValid('user@localhost')).toBe(false);
  });

  it('sign-in accepts any non-empty password up to the max and does not apply the invite minimum', () => {
    expect(validateSignInFields({ email: 'host@example.com', password: 'short' })).toEqual({});
    expect(validateSignInFields({ email: 'bad', password: '' })).toEqual({
      email: SIGN_IN_FIELD_ERROR.email,
      password: SIGN_IN_FIELD_ERROR.password,
    });
    expect(
      validateSignInFields({
        email: 'host@example.com',
        password: 'x'.repeat(PASSWORD_MAX_LENGTH + 1),
      }),
    ).toEqual({ password: SIGN_IN_FIELD_ERROR.passwordLong });
    expect(hasPasswordEntryFieldErrors(validateSignInFields({ email: '', password: '' }))).toBe(
      true,
    );
  });

  it('invite password step shows a field error for a short password', () => {
    expect(validateInvitePasswordFields({ email: 'host@example.com', password: 'short' })).toEqual({
      password: INVITE_PASSWORD_FIELD_ERROR.password,
    });
    expect(
      validateInvitePasswordFields({
        email: 'not-an-email',
        password: 'x'.repeat(PASSWORD_MIN_LENGTH),
      }),
    ).toEqual({ email: INVITE_PASSWORD_FIELD_ERROR.email });
    expect(
      validateInvitePasswordFields({
        email: 'host@example.com',
        password: 'x'.repeat(PASSWORD_MAX_LENGTH + 1),
      }),
    ).toEqual({ password: INVITE_PASSWORD_FIELD_ERROR.passwordLong });
    expect(
      validateInvitePasswordFields({
        email: 'host@example.com',
        password: 'x'.repeat(PASSWORD_MIN_LENGTH),
      }),
    ).toEqual({});
  });
});
