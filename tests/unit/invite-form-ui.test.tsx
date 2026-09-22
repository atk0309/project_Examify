/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcceptInvitePasswordState } from '@/actions/acceptInviteWithPassword';
import type { CompletePasswordInviteState } from '@/actions/completePasswordInvite';
import { InviteAcceptForm } from '@/components/exam/InviteAcceptForm';
import type { ResolvedMailTransport } from '@/lib/auth-mode';
import { inviteCodeDestination } from '@/lib/mailbox-copy';
import { PASSWORD_MISMATCH } from '@/lib/password-policy';

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

vi.mock('@/actions/acceptInviteWithPassword', () => ({
  acceptInviteWithPassword: (prev: unknown, formData: FormData) =>
    acceptInviteWithPassword(prev, formData),
}));

vi.mock('@/actions/completePasswordInvite', () => ({
  completePasswordInvite: (prev: unknown, formData: FormData) =>
    completePasswordInvite(prev, formData),
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

function renderInvite(codeDelivery: ResolvedMailTransport = 'outbox') {
  return render(
    <InviteAcceptForm
      inviteToken="invite-token"
      role="student"
      lockedEmail={null}
      authMode="password"
      codeDelivery={codeDelivery}
    />,
  );
}

async function sendCode(codeDelivery: ResolvedMailTransport = 'outbox') {
  acceptInviteWithPassword.mockImplementation(async () => ({
    status: 'sent',
    email: 'alex@example.com',
  }));
  renderInvite(codeDelivery);
  autofillWithoutEvents('invite-email-input', 'alex@example.com');
  autofillWithoutEvents('invite-password-input', 'student-pass');
  autofillWithoutEvents('invite-confirm-password-input', 'student-pass');
  fireEvent.submit(screen.getByTestId('invite-form'));
  return screen.findByTestId('invite-otp-form');
}

describe('Password invite form', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    acceptInviteWithPassword.mockClear();
    completePasswordInvite.mockClear();
    acceptInviteWithPassword.mockImplementation(async () => ({ status: 'idle' }));
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

  it.each(['resend', 'smtp', 'outbox'] as const)(
    'names the %s transport on the password step and the code step',
    async (transport) => {
      const where = inviteCodeDestination(transport);
      acceptInviteWithPassword.mockImplementation(async () => ({
        status: 'sent',
        email: 'alex@example.com',
      }));
      renderInvite(transport);
      expect(screen.getByTestId('invite-form')).toHaveTextContent(where);
      expect(screen.getByTestId('invite-form')).toHaveTextContent('Next, enter the one-time code');
      autofillWithoutEvents('invite-email-input', 'alex@example.com');
      autofillWithoutEvents('invite-password-input', 'student-pass');
      autofillWithoutEvents('invite-confirm-password-input', 'student-pass');
      fireEvent.submit(screen.getByTestId('invite-form'));

      const otp = await screen.findByTestId('invite-otp-form');
      expect(otp).toHaveTextContent(where);
      expect(screen.getByTestId('invite-otp-handoff')).toHaveTextContent(
        'The password you chose is waiting on this code',
      );
      expect(screen.getByTestId('invite-otp-handoff')).toHaveTextContent('alex@example.com');
      expect(screen.getByTestId('invite-otp-handoff')).toHaveTextContent(
        'Enter it to finish joining',
      );
      expect(screen.getByRole('heading', { name: 'Enter your confirmation code' })).toBeVisible();
      expect(screen.getByTestId('invite-otp-resend-hint')).toHaveTextContent('Need a new code?');
      expect(screen.getByTestId('invite-otp-back')).toHaveTextContent('Send a new code');
      expect(screen.queryByDisplayValue('student-pass')).toBeNull();

      for (const other of ['resend', 'smtp', 'outbox'] as const) {
        if (other === transport) continue;
        expect(otp).not.toHaveTextContent(inviteCodeDestination(other));
      }
    },
  );

  it('explains the pending code when sending another one', async () => {
    await sendCode('smtp');
    fireEvent.click(screen.getByTestId('invite-otp-back'));
    const pending = screen.getByTestId('invite-code-pending');
    expect(pending).toHaveTextContent(inviteCodeDestination('smtp'));
    expect(pending).toHaveTextContent('still matches the password');
    expect(pending).toHaveTextContent('Send a new code to replace it');
    expect(screen.queryByTestId('invite-otp-form')).toBeNull();
    expect(completePasswordInvite).not.toHaveBeenCalled();
  });

  it('cannot finish the join without the mailbox code', async () => {
    await sendCode('resend');
    expect(screen.queryByRole('button', { name: /skip/i })).toBeNull();
    expect(screen.getByTestId('otp-submit')).toBeDisabled();
    expect(
      screen.getByTestId('invite-otp-form').querySelector('input[name="password"]'),
    ).toBeNull();

    fireEvent.submit(screen.getByTestId('invite-otp-form'));
    fireEvent.change(screen.getByTestId('otp-input'), { target: { value: '12345' } });
    fireEvent.submit(screen.getByTestId('invite-otp-form'));
    expect(completePasswordInvite).not.toHaveBeenCalled();
    expect(screen.getByTestId('otp-submit')).toBeDisabled();

    fireEvent.change(screen.getByTestId('otp-input'), { target: { value: '123456' } });
    expect(screen.getByTestId('otp-submit')).toBeEnabled();
    fireEvent.submit(screen.getByTestId('invite-otp-form'));
    expect(completePasswordInvite).toHaveBeenCalledOnce();
    const formData = completePasswordInvite.mock.calls[0]?.[1] as FormData;
    expect(formData.get('code')).toBe('123456');
    expect(formData.get('password')).toBeNull();
    expect(formData.get('email')).toBe('alex@example.com');
  });
});
