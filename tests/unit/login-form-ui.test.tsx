/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignInPasswordState } from '@/actions/signInWithPassword';
import { LoginForm } from '@/components/exam/LoginForm';

const signInWithPassword = vi.fn(
  async (_prev: unknown, _formData: FormData): Promise<SignInPasswordState> => ({
    status: 'idle',
  }),
);

vi.mock('@/actions/signInWithPassword', () => ({
  signInWithPassword: (prev: unknown, formData: FormData) => signInWithPassword(prev, formData),
}));

vi.mock('@/actions/requestPasswordReset', () => ({
  requestPasswordReset: vi.fn(async () => ({ status: 'idle' })),
}));

vi.mock('@/actions/completePasswordReset', () => ({
  completePasswordReset: vi.fn(async () => ({ status: 'idle' })),
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
  });

  it('keeps Sign in enabled before the fields are filled', () => {
    render(<LoginForm authMode="password" />);
    expect(screen.getByTestId('signin-submit')).toBeEnabled();
  });

  it('submits DOM values after autofill that never fires onChange', () => {
    render(<LoginForm authMode="password" />);
    autofillWithoutEvents('email-input', 'pat@example.com');
    autofillWithoutEvents('password-input', 'correct-horse');
    fireEvent.submit(screen.getByTestId('signin-form'));
    expect(signInWithPassword).toHaveBeenCalledOnce();
    const formData = signInWithPassword.mock.calls[0]?.[1] as FormData;
    expect(formData.get('email')).toBe('pat@example.com');
    expect(formData.get('password')).toBe('correct-horse');
    expect(formData.get('role')).toBe('student');
  });

  it('says email, password, or role when sign-in fails', async () => {
    signInWithPassword.mockImplementation(async () => ({ status: 'error', reason: 'invalid' }));
    render(<LoginForm authMode="password" />);
    autofillWithoutEvents('email-input', 'pat@example.com');
    autofillWithoutEvents('password-input', 'wrong-password');
    fireEvent.submit(screen.getByTestId('signin-form'));
    expect(await screen.findByTestId('signin-error-invalid')).toHaveTextContent(
      "Email, password, or role didn't match.",
    );
  });
});
