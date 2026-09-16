import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EMAIL_RE,
  hasSetupFieldErrors,
  isFieldMappedBootstrapReason,
  isSetupEmailValid,
  readSetupFields,
  captureSilentSetupSnapshot,
  isDefaultOnlySetupSnapshot,
  recoverSetupFieldsAfterRemount,
  resolveSetupFieldErrors,
  SETUP_DEFAULT_HOUSEHOLD_NAME,
  SETUP_FIELD_ERROR,
  SETUP_HOUSEHOLD_NAME_MAX,
  setupFieldErrorsFromServer,
  validateSetupFields,
} from '@/lib/setup-form';

/** Same email pipe as `bootstrapHouseholdAction` — client must not be looser. */
const serverEmail = z.string().trim().toLowerCase().email();

function fields(over: Partial<ReturnType<typeof readSetupFields>> = {}) {
  return {
    householdName: SETUP_DEFAULT_HOUSEHOLD_NAME,
    setupSecret: 'dev-setup-bootstrap-secret',
    email: 'host@example.com',
    password: '',
    ...over,
  };
}

describe('setup-form email guard', () => {
  it('keeps EMAIL_RE aligned with server z.email() and does not go looser', () => {
    const accepted = ['host@example.com', 'Ada.Lovelace@Example.COM', 'a@b.co'];
    const rejected = [
      '',
      'plain',
      'user@',
      '@example.com',
      'user@localhost',
      'user@com',
      'user name@example.com',
      'user@exam ple.com',
    ];

    for (const value of accepted) {
      expect(isSetupEmailValid(value), value).toBe(true);
      expect(serverEmail.safeParse(value).success, `z.email(${value})`).toBe(true);
    }
    for (const value of rejected) {
      expect(isSetupEmailValid(value), value).toBe(false);
    }

    const corpus = [...accepted, ...rejected, 'not-an-email', 'foo@bar'];
    for (const value of corpus) {
      if (isSetupEmailValid(value)) {
        expect(serverEmail.safeParse(value).success, `client accepted ${value}`).toBe(true);
      }
    }
    expect(EMAIL_RE.test('host@example.com')).toBe(true);
  });

  it('keeps the client household-name cap aligned with the server', async () => {
    const { HOUSEHOLD_NAME_MAX } = await import('@/lib/households');
    expect(SETUP_HOUSEHOLD_NAME_MAX).toBe(HOUSEHOLD_NAME_MAX);
  });
});

describe('readSetupFields / validateSetupFields', () => {
  it('reads DOM FormData so autofill without React onChange is still visible', () => {
    const data = new FormData();
    data.set('householdName', 'Autofill family');
    data.set('setupSecret', 'instance-secret');
    data.set('email', 'autofill@example.com');
    data.set('password', 'admin-password');
    expect(readSetupFields(data)).toEqual({
      householdName: 'Autofill family',
      setupSecret: 'instance-secret',
      email: 'autofill@example.com',
      password: 'admin-password',
    });
  });

  it('requires household name, setup code, and a valid admin email', () => {
    expect(validateSetupFields(fields({ householdName: '   ' }), 'magic-link')).toEqual({
      householdName: SETUP_FIELD_ERROR.householdName,
    });
    expect(validateSetupFields(fields({ setupSecret: '' }), 'magic-link')).toEqual({
      setupSecret: SETUP_FIELD_ERROR.setupSecret,
    });
    expect(validateSetupFields(fields({ email: 'not-an-email' }), 'magic-link')).toEqual({
      email: SETUP_FIELD_ERROR.email,
    });
    expect(
      validateSetupFields(
        fields({ householdName: 'x'.repeat(SETUP_HOUSEHOLD_NAME_MAX + 1) }),
        'magic-link',
      ),
    ).toEqual({ householdName: SETUP_FIELD_ERROR.householdNameLong });
    expect(validateSetupFields(fields(), 'magic-link')).toEqual({});
  });

  it('requires a policy-length password only in password mode', () => {
    expect(validateSetupFields(fields({ password: '' }), 'magic-link')).toEqual({});
    expect(validateSetupFields(fields({ password: 'short' }), 'password')).toEqual({
      password: SETUP_FIELD_ERROR.password,
    });
    expect(validateSetupFields(fields({ password: 'x'.repeat(201) }), 'password')).toEqual({
      password: SETUP_FIELD_ERROR.passwordLong,
    });
    expect(hasSetupFieldErrors(validateSetupFields(fields({ password: '' }), 'password'))).toBe(
      true,
    );
    expect(validateSetupFields(fields({ password: 'admin-password' }), 'password')).toEqual({});
  });

  it('maps server forbidden/invalid onto the fields the operator can fix', () => {
    expect(setupFieldErrorsFromServer('forbidden', 'magic-link')).toEqual({
      setupSecret: 'That setup code is not valid.',
    });
    expect(setupFieldErrorsFromServer('invalid', 'magic-link')).toEqual({
      householdName: SETUP_FIELD_ERROR.householdName,
      email: SETUP_FIELD_ERROR.email,
    });
    expect(setupFieldErrorsFromServer('invalid', 'password')).toMatchObject({
      email: SETUP_FIELD_ERROR.email,
      password: SETUP_FIELD_ERROR.password,
    });
    expect(setupFieldErrorsFromServer('captcha', 'magic-link')).toEqual({});
    expect(isFieldMappedBootstrapReason('forbidden')).toBe(true);
    expect(isFieldMappedBootstrapReason('invalid')).toBe(true);
    expect(isFieldMappedBootstrapReason('captcha')).toBe(false);
  });

  it('drops a server field error only after a successful edit of that field', () => {
    const server = setupFieldErrorsFromServer('forbidden', 'magic-link');
    expect(resolveSetupFieldErrors({ local: {}, server, successfullyEdited: {} }).setupSecret).toBe(
      'That setup code is not valid.',
    );
    expect(
      resolveSetupFieldErrors({
        local: {},
        server,
        successfullyEdited: { email: true },
      }).setupSecret,
    ).toBe('That setup code is not valid.');
    expect(
      resolveSetupFieldErrors({
        local: {},
        server,
        successfullyEdited: { setupSecret: true },
      }),
    ).toEqual({});
    expect(
      resolveSetupFieldErrors({
        local: { setupSecret: SETUP_FIELD_ERROR.setupSecret },
        server,
        successfullyEdited: {},
      }).setupSecret,
    ).toBe(SETUP_FIELD_ERROR.setupSecret);
  });

  it('re-reads a remount wipe back from the FormData snapshot', () => {
    const snapshot = fields({
      householdName: 'Autofill family',
      setupSecret: 'instance-secret',
      email: 'autofill@example.com',
    });
    const wiped = fields({
      householdName: SETUP_DEFAULT_HOUSEHOLD_NAME,
      setupSecret: '',
      email: '',
    });
    expect(recoverSetupFieldsAfterRemount(wiped, snapshot)).toEqual({
      householdName: 'Autofill family',
      setupSecret: 'instance-secret',
      email: 'autofill@example.com',
      password: '',
    });
    expect(recoverSetupFieldsAfterRemount(snapshot, snapshot)).toEqual(snapshot);
    expect(recoverSetupFieldsAfterRemount(wiped, null)).toEqual(wiped);
  });

  it('does not let the first-paint default household name poison the snapshot', () => {
    const firstPaint = fields({
      householdName: SETUP_DEFAULT_HOUSEHOLD_NAME,
      setupSecret: '',
      email: '',
      password: '',
    });
    expect(isDefaultOnlySetupSnapshot(firstPaint)).toBe(true);
    expect(captureSilentSetupSnapshot(firstPaint, null)).toBeNull();

    const autofilled = fields({
      householdName: 'Autofill family',
      setupSecret: '',
      email: '',
      password: '',
    });
    expect(captureSilentSetupSnapshot(autofilled, null)).toEqual(autofilled);
    expect(
      recoverSetupFieldsAfterRemount(
        fields({ householdName: SETUP_DEFAULT_HOUSEHOLD_NAME, setupSecret: '', email: '' }),
        autofilled,
      ).householdName,
    ).toBe('Autofill family');
  });

  it('never resurrects a cleared password from an older snapshot', () => {
    const snapshot = fields({
      householdName: 'Autofill family',
      setupSecret: 'instance-secret',
      email: 'autofill@example.com',
      password: 'admin-password',
    });
    const afterClear = fields({
      householdName: SETUP_DEFAULT_HOUSEHOLD_NAME,
      setupSecret: '',
      email: '',
      password: '',
    });
    expect(recoverSetupFieldsAfterRemount(afterClear, snapshot)).toEqual({
      householdName: 'Autofill family',
      setupSecret: 'instance-secret',
      email: 'autofill@example.com',
      password: '',
    });
    expect(
      captureSilentSetupSnapshot(fields({ ...snapshot, password: '' }), snapshot)?.password,
    ).toBe('admin-password');
  });
});
