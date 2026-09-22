/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcceptInvitePasswordState } from '@/actions/acceptInviteWithPassword';
import { InviteAcceptForm } from '@/components/exam/InviteAcceptForm';
import { PASSWORD_MISMATCH } from '@/lib/password-policy';

const acceptInviteWithPassword = vi.fn(
  async (_prev: unknown, _formData: FormData): Promise<AcceptInvitePasswordState> => ({
    status: 'idle',
  }),
);

vi.mock('@/actions/acceptInviteWithPassword', () => ({
  acceptInviteWithPassword: (prev: unknown, formData: FormData) =>
    acceptInviteWithPassword(prev, formData),
}));

vi.mock('@/actions/completePasswordInvite', () => ({
  completePasswordInvite: vi.fn(async () => ({ status: 'idle' })),
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

function renderInvite(mailboxDelivery: 'inbox' | 'outbox' = 'inbox') {
  return render(
    <InviteAcceptForm
      inviteToken="invite-token"
      role="student"
      lockedEmail={null}
      authMode="password"
      mailboxDelivery={mailboxDelivery}
    />,
  );
}

describe('Password invite form', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    acceptInviteWithPassword.mockClear();
  });

  it('keeps send enabled before the password meets the policy', () => {
    renderInvite();
    expect(screen.getByTestId('invite-submit')).toBeEnabled();
    expect(screen.getByTestId('invite-password-input')).toHaveAttribute(
      'aria-describedby',
      'invite-password-hint',
    );
  });

  it('submits autofilled DOM values and shows a short-password field error', () => {
    renderInvite();
    autofillWithoutEvents('invite-email-input', 'alex@example.com');
    autofillWithoutEvents('invite-password-input', 'short');
    autofillWithoutEvents('invite-confirm-password-input', 'short');
    fireEvent.submit(screen.getByTestId('invite-form'));
    expect(acceptInviteWithPassword).not.toHaveBeenCalled();
    expect(screen.getByTestId('invite-password-error')).toHaveTextContent('at least 10');
    expect(screen.getByTestId('invite-password-input')).toHaveAttribute('aria-invalid', 'true');

    autofillWithoutEvents('invite-password-input', 'student-pass');
    autofillWithoutEvents('invite-confirm-password-input', 'student-pass');
    fireEvent.submit(screen.getByTestId('invite-form'));
    expect(acceptInviteWithPassword).toHaveBeenCalledOnce();
    const formData = acceptInviteWithPassword.mock.calls[0]?.[1] as FormData;
    expect(formData.get('email')).toBe('alex@example.com');
    expect(formData.get('password')).toBe('student-pass');
    expect(formData.get('confirmPassword')).toBe('student-pass');
  });

  it('names a confirmation mismatch and does not send', () => {
    renderInvite();
    autofillWithoutEvents('invite-email-input', 'alex@example.com');
    autofillWithoutEvents('invite-password-input', 'student-pass');
    autofillWithoutEvents('invite-confirm-password-input', 'other-password');
    fireEvent.submit(screen.getByTestId('invite-form'));
    expect(acceptInviteWithPassword).not.toHaveBeenCalled();
    expect(screen.getByTestId('invite-confirm-error')).toHaveTextContent(PASSWORD_MISMATCH);
  });

  it('tells an outbox host to check the outbox after the code is sent', async () => {
    acceptInviteWithPassword.mockImplementation(async () => ({
      status: 'sent',
      email: 'alex@example.com',
    }));
    renderInvite('outbox');
    autofillWithoutEvents('invite-email-input', 'alex@example.com');
    autofillWithoutEvents('invite-password-input', 'student-pass');
    autofillWithoutEvents('invite-confirm-password-input', 'student-pass');
    fireEvent.submit(screen.getByTestId('invite-form'));
    expect(await screen.findByTestId('invite-otp-form')).toHaveTextContent(
      'the mail outbox on this host',
    );
    expect(screen.getByTestId('invite-otp-form')).not.toHaveTextContent('your inbox');
    expect(screen.queryByDisplayValue('student-pass')).toBeNull();
  });

  it('tells an inbox host to check the inbox', async () => {
    acceptInviteWithPassword.mockImplementation(async () => ({
      status: 'sent',
      email: 'alex@example.com',
    }));
    renderInvite('inbox');
    autofillWithoutEvents('invite-email-input', 'alex@example.com');
    autofillWithoutEvents('invite-password-input', 'student-pass');
    autofillWithoutEvents('invite-confirm-password-input', 'student-pass');
    fireEvent.submit(screen.getByTestId('invite-form'));
    expect(await screen.findByTestId('invite-otp-form')).toHaveTextContent('your inbox');
    expect(screen.getByTestId('invite-otp-form')).not.toHaveTextContent('mail outbox');
  });
});
