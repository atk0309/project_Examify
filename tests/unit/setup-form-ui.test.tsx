/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapState } from '@/actions/bootstrapHousehold';
import { SetupForm } from '@/components/exam/SetupForm';
import { SETUP_FIELD_ERROR } from '@/lib/setup-form';

const bootstrapHouseholdAction = vi.fn(
  async (_prev: unknown, _formData: FormData): Promise<BootstrapState> => ({
    status: 'idle',
  }),
);

vi.mock('@/actions/bootstrapHousehold', () => ({
  bootstrapHouseholdAction: (prev: unknown, formData: FormData) =>
    bootstrapHouseholdAction(prev, formData),
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

describe('SetupForm autofill desync', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    bootstrapHouseholdAction.mockClear();
  });

  it('keeps Create household enabled when fields are empty (no silent dead button)', () => {
    render(<SetupForm authMode="magic-link" />);
    const submit = screen.getByTestId('setup-submit');
    expect(submit).toBeEnabled();
    expect(submit).toHaveTextContent('Create household');
  });

  it('submits DOM values after autofill that never fires onChange', async () => {
    render(<SetupForm authMode="magic-link" />);
    autofillWithoutEvents('household-name-input', 'Autofill family');
    autofillWithoutEvents('setup-secret-input', 'instance-secret');
    autofillWithoutEvents('setup-email-input', 'autofill@example.com');

    fireEvent.submit(screen.getByTestId('setup-form'));

    expect(bootstrapHouseholdAction).toHaveBeenCalledOnce();
    const formData = bootstrapHouseholdAction.mock.calls[0]?.[1];
    expect(formData).toBeInstanceOf(FormData);
    expect(formData?.get('householdName')).toBe('Autofill family');
    expect(formData?.get('setupSecret')).toBe('instance-secret');
    expect(formData?.get('email')).toBe('autofill@example.com');
    expect(screen.queryByTestId('setup-email-error')).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('setup-email-input')).toHaveValue('autofill@example.com');
    });
    expect(screen.getByTestId('setup-secret-input')).toHaveValue('instance-secret');
  });

  it('keeps autofilled values after a server forbidden response', async () => {
    bootstrapHouseholdAction.mockImplementation(async () => ({
      status: 'error',
      reason: 'forbidden',
    }));
    render(<SetupForm authMode="magic-link" />);
    autofillWithoutEvents('household-name-input', 'Autofill family');
    autofillWithoutEvents('setup-secret-input', 'definitely-not-the-setup-secret');
    autofillWithoutEvents('setup-email-input', 'autofill@example.com');

    fireEvent.submit(screen.getByTestId('setup-form'));

    await waitFor(() => {
      expect(screen.getByTestId('setup-error-forbidden')).toBeVisible();
    });
    expect(screen.getByTestId('setup-email-input')).toHaveValue('autofill@example.com');
    expect(screen.getByTestId('setup-secret-input')).toHaveValue('definitely-not-the-setup-secret');
    expect(screen.getByTestId('setup-secret-error')).toHaveTextContent(
      'That setup code is not valid.',
    );
  });

  it('syncs onInput after a failed submit and clears the field error', () => {
    render(<SetupForm authMode="magic-link" />);
    fireEvent.submit(screen.getByTestId('setup-form'));

    const email = screen.getByTestId('setup-email-input');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('setup-email-error')).toHaveTextContent(SETUP_FIELD_ERROR.email);
    expect(bootstrapHouseholdAction).not.toHaveBeenCalled();

    fireEvent.input(email, { target: { value: 'host@example.com' } });
    fireEvent.input(screen.getByTestId('setup-secret-input'), {
      target: { value: 'instance-secret' },
    });

    expect(email).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByTestId('setup-email-error')).toBeNull();
    expect(screen.queryByTestId('setup-secret-error')).toBeNull();
  });

  it('surfaces password-mode copy that email is the required admin account id', () => {
    render(<SetupForm authMode="password" />);
    expect(screen.getByTestId('setup-auth-mode-copy')).toHaveTextContent(
      'Your email is the required admin account id',
    );
    expect(screen.getByTestId('setup-email-hint')).toHaveTextContent(
      'This email is the admin account id, not optional',
    );
    expect(screen.getByLabelText('Admin email')).toBeRequired();

    fireEvent.submit(screen.getByTestId('setup-form'));
    expect(screen.getByTestId('setup-email-error')).toBeVisible();
    expect(screen.getByTestId('setup-password-error')).toHaveTextContent(
      SETUP_FIELD_ERROR.password,
    );
    expect(bootstrapHouseholdAction).not.toHaveBeenCalled();
  });
});
