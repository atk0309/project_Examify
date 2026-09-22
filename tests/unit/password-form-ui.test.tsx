/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcceptInvitePasswordState } from '@/actions/acceptInviteWithPassword';
import type { CompletePasswordInviteState } from '@/actions/completePasswordInvite';
import type { SignInPasswordState } from '@/actions/signInWithPassword';
import { InviteAcceptForm } from '@/components/exam/InviteAcceptForm';
import { LoginForm } from '@/components/exam/LoginForm';
import { INVITE_PASSWORD_FIELD_ERROR, SIGN_IN_FIELD_ERROR } from '@/lib/password-entry-form';

const signInWithPassword = vi.fn(
  async (_prev: unknown, _formData: FormData): Promise<SignInPasswordState> => ({
    status: 'idle',
  }),
);

const acceptInviteWithPassword = vi.fn(
  async (_prev: unknown, _formData: FormData): Promise<AcceptInvitePasswordState> => ({
    status: 'idle',
  }),
);

const completePasswordInvite = vi.fn(
  async (_prev: unknown, _formData: FormData): Promise<CompletePasswordInviteState> => ({
    status: 'idle',
  }),
);

vi.mock('@/actions/signInWithPassword', () => ({
  signInWithPassword: (prev: unknown, formData: FormData) => signInWithPassword(prev, formData),
}));

vi.mock('@/actions/acceptInviteWithPassword', () => ({
  acceptInviteWithPassword: (prev: unknown, formData: FormData) =>
    acceptInviteWithPassword(prev, formData),
}));

vi.mock('@/actions/completePasswordInvite', () => ({
  completePasswordInvite: (prev: unknown, formData: FormData) =>
    completePasswordInvite(prev, formData),
}));

vi.mock('@/actions/requestMagicLink', () => ({
  requestMagicLink: async () => ({ status: 'idle' }),
}));

vi.mock('@/actions/verifyLocalOtp', () => ({
  verifyLocalOtp: async () => ({ status: 'idle' }),
}));

vi.mock('@/actions/requestInviteLink', () => ({
  requestInviteLink: async () => ({ status: 'idle' }),
}));

vi.mock('next/script', () => ({
  default: function Script() {
    return null;
  },
}));

function autofillWithoutEvents(testId: string, value: string) {
  const input = screen.getByTestId(testId) as HTMLInputElement;
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
}

describe('PasswordLoginForm autofill', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    signInWithPassword.mockClear();
    signInWithPassword.mockImplementation(async () => ({ status: 'idle' }));
  });

  it('keeps Sign in enabled when fields are empty', () => {
    render(<LoginForm authMode="password" />);
    const submit = screen.getByTestId('signin-submit');
    expect(submit).toBeEnabled();
    expect(submit).toHaveTextContent('Sign in');
  });

  it('submits DOM email and password after autofill that never fires onChange', () => {
    render(<LoginForm authMode="password" />);
    autofillWithoutEvents('email-input', 'autofill@example.com');
    autofillWithoutEvents('password-input', 'correct-horse');
    fireEvent.click(screen.getByRole('radio', { name: 'Parent' }));

    fireEvent.submit(screen.getByTestId('signin-form'));

    expect(signInWithPassword).toHaveBeenCalledOnce();
    const formData = signInWithPassword.mock.calls[0]?.[1];
    expect(formData).toBeInstanceOf(FormData);
    expect(formData?.get('email')).toBe('autofill@example.com');
    expect(formData?.get('password')).toBe('correct-horse');
    expect(formData?.get('role')).toBe('parent');
    expect(screen.queryByTestId('signin-email-error')).toBeNull();
    expect(screen.queryByTestId('signin-password-error')).toBeNull();
  });

  it('shows one invalid banner for a wrong password and does not split the reason', async () => {
    signInWithPassword.mockImplementation(async () => ({ status: 'error', reason: 'invalid' }));
    render(<LoginForm authMode="password" />);
    autofillWithoutEvents('email-input', 'pat@example.com');
    autofillWithoutEvents('password-input', 'not-the-password');

    fireEvent.submit(screen.getByTestId('signin-form'));

    await waitFor(() => {
      expect(screen.getByTestId('signin-error-invalid')).toHaveTextContent(
        'Email or password is incorrect.',
      );
    });
    expect(screen.queryByTestId('signin-error-captcha')).toBeNull();
    expect(screen.queryByTestId('signin-password-error')).toBeNull();
    expect(signInWithPassword).toHaveBeenCalledOnce();
  });

  it('shows field errors for an empty submit and does not call the action', () => {
    render(<LoginForm authMode="password" />);
    fireEvent.submit(screen.getByTestId('signin-form'));

    expect(screen.getByTestId('signin-email-error')).toHaveTextContent(SIGN_IN_FIELD_ERROR.email);
    expect(screen.getByTestId('signin-password-error')).toHaveTextContent(
      SIGN_IN_FIELD_ERROR.password,
    );
    expect(screen.getByTestId('email-input')).toHaveAttribute('aria-invalid', 'true');
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(screen.getByTestId('signin-submit')).toBeEnabled();
  });

  it('clears a field error on input after a failed attempt', () => {
    render(<LoginForm authMode="password" />);
    fireEvent.submit(screen.getByTestId('signin-form'));
    expect(screen.getByTestId('signin-email-error')).toBeVisible();

    fireEvent.input(screen.getByTestId('email-input'), { target: { value: 'host@example.com' } });
    fireEvent.input(screen.getByTestId('password-input'), { target: { value: 'correct-horse' } });

    expect(screen.queryByTestId('signin-email-error')).toBeNull();
    expect(screen.queryByTestId('signin-password-error')).toBeNull();
    expect(screen.getByTestId('email-input')).not.toHaveAttribute('aria-invalid');
  });
});

describe('Password invite step autofill', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    acceptInviteWithPassword.mockClear();
    completePasswordInvite.mockClear();
    acceptInviteWithPassword.mockImplementation(async () => ({ status: 'idle' }));
  });

  it('keeps Send confirmation code enabled when fields are empty', () => {
    render(
      <InviteAcceptForm
        authMode="password"
        inviteToken="invite-token"
        role="student"
        lockedEmail={null}
      />,
    );
    const submit = screen.getByTestId('invite-submit');
    expect(submit).toBeEnabled();
    expect(submit).toHaveTextContent('Send confirmation code');
  });

  it('requests a code from DOM values after autofill that never fires onChange', async () => {
    acceptInviteWithPassword.mockImplementation(async () => ({
      status: 'sent',
      email: 'autofill@example.com',
    }));
    render(
      <InviteAcceptForm
        authMode="password"
        inviteToken="invite-token"
        role="student"
        lockedEmail={null}
      />,
    );
    autofillWithoutEvents('invite-email-input', 'autofill@example.com');
    autofillWithoutEvents('invite-password-input', 'long-enough-password');

    fireEvent.submit(screen.getByTestId('invite-form'));

    expect(acceptInviteWithPassword).toHaveBeenCalledOnce();
    const formData = acceptInviteWithPassword.mock.calls[0]?.[1];
    expect(formData?.get('email')).toBe('autofill@example.com');
    expect(formData?.get('password')).toBe('long-enough-password');
    expect(formData?.get('inviteToken')).toBe('invite-token');
    expect(completePasswordInvite).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByTestId('invite-otp-form')).toBeInTheDocument();
    });
    expect(screen.getByTestId('otp-submit')).toBeDisabled();
    const hiddenPassword = screen
      .getByTestId('invite-otp-form')
      .querySelector('input[name="password"]');
    expect(hiddenPassword).toHaveValue('long-enough-password');
  });

  it('shows a field error for a short password and does not request a code', () => {
    render(
      <InviteAcceptForm
        authMode="password"
        inviteToken="invite-token"
        role="student"
        lockedEmail="kid@example.com"
      />,
    );
    autofillWithoutEvents('invite-password-input', 'short');

    fireEvent.submit(screen.getByTestId('invite-form'));

    expect(screen.getByTestId('invite-password-error')).toHaveTextContent(
      INVITE_PASSWORD_FIELD_ERROR.password,
    );
    expect(screen.getByTestId('invite-password-input')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByTestId('invite-email-error')).toBeNull();
    expect(acceptInviteWithPassword).not.toHaveBeenCalled();
    expect(completePasswordInvite).not.toHaveBeenCalled();
    expect(screen.getByTestId('invite-submit')).toBeEnabled();
    expect(screen.queryByTestId('invite-otp-form')).toBeNull();
  });

  it('drops the short-password error on the next successful edit', () => {
    render(
      <InviteAcceptForm
        authMode="password"
        inviteToken="invite-token"
        role="parent"
        lockedEmail="pat@example.com"
      />,
    );
    fireEvent.submit(screen.getByTestId('invite-form'));
    expect(screen.getByTestId('invite-password-error')).toBeVisible();

    fireEvent.input(screen.getByTestId('invite-password-input'), {
      target: { value: 'long-enough-password' },
    });

    expect(screen.queryByTestId('invite-password-error')).toBeNull();
    expect(screen.getByTestId('invite-password-input')).not.toHaveAttribute('aria-invalid');
    expect(acceptInviteWithPassword).not.toHaveBeenCalled();
  });
});
