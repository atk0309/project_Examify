'use client';

import Script from 'next/script';
import { useActionState, useRef, useState, type FormEvent } from 'react';
import { bootstrapHouseholdAction, type BootstrapState } from '@/actions/bootstrapHousehold';
import type { AuthMode } from '@/lib/auth-mode';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import {
  hasSetupFieldErrors,
  readSetupFields,
  SETUP_HOUSEHOLD_NAME_MAX,
  setupFieldErrorsFromServer,
  type SetupFieldErrors,
  validateSetupFields,
} from '@/lib/setup-form';

const errorCopy: Record<Exclude<BootstrapState, { status: 'idle' }>['reason'], string> = {
  invalid: 'Please enter a household name and a valid email address.',
  already_setup: 'This instance is already set up. Sign in instead.',
  captcha: 'Verification failed. Please try again.',
  rate_limited: 'Too many attempts from your network. Try again later.',
  forbidden: 'That setup code is not valid.',
};

const AUTH_MODE_COPY: Record<AuthMode, string> = {
  password:
    'This instance uses email + password sign-in. Your email is the required admin account id; choose a password for that account.',
  'magic-link':
    'This instance uses magic-link sign-in. After setup you will sign in with an email link.',
  'local-otp':
    'This instance uses a local one-time code. After setup, codes are written to the mail outbox.',
};

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p className="field-error" id={id} role="alert" data-testid={id}>
      {message}
    </p>
  );
}

export function SetupForm({ siteKey, authMode }: { siteKey?: string; authMode: AuthMode }) {
  const [state, formAction, pending] = useActionState<BootstrapState, FormData>(
    bootstrapHouseholdAction,
    { status: 'idle' },
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [householdName, setHouseholdName] = useState('Our family');
  const [setupSecret, setSetupSecret] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<SetupFieldErrors>({});

  const errors: SetupFieldErrors = {
    ...(state.status === 'error' ? setupFieldErrorsFromServer(state.reason) : {}),
    ...fieldErrors,
  };

  function applyFields(fields: ReturnType<typeof readSetupFields>) {
    setHouseholdName(fields.householdName);
    setSetupSecret(fields.setupSecret);
    setEmail(fields.email);
    setPassword(fields.password);
  }

  function refreshErrorsFromDom(form: HTMLFormElement) {
    const fields = readSetupFields(new FormData(form));
    applyFields(fields);
    if (attempted) setFieldErrors(validateSetupFields(fields, authMode));
  }

  function onFieldInput(event: FormEvent<HTMLInputElement>) {
    const form = event.currentTarget.form ?? formRef.current;
    if (form) refreshErrorsFromDom(form);
  }

  function submit(formData: FormData) {
    const fields = readSetupFields(formData);
    applyFields(fields);
    const nextErrors = validateSetupFields(fields, authMode);
    setAttempted(true);
    setFieldErrors(nextErrors);
    if (hasSetupFieldErrors(nextErrors)) return;
    formAction(formData);
  }

  const emailInvalid = Boolean(errors.email);
  const nameInvalid = Boolean(errors.householdName);
  const secretInvalid = Boolean(errors.setupSecret);
  const passwordInvalid = Boolean(errors.password);

  return (
    <form
      ref={formRef}
      className="screen login login-setup"
      action={submit}
      noValidate
      data-testid="setup-form"
    >
      {siteKey ? (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          async
          defer
          strategy="afterInteractive"
        />
      ) : null}
      <div className="login-head">
        <span className="brand-mark">E</span>
        <h1 className="brand-word">Set up Examify</h1>
        <p className="login-sub">
          First person here becomes the household admin. Enter the setup code configured on this
          instance, then invite students and other parents from the dashboard — no env JSON to edit.
        </p>
        <p className="login-fine" data-testid="setup-auth-mode-copy">
          {AUTH_MODE_COPY[authMode]}
        </p>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="setup-household">
          Household name
        </label>
        <input
          id="setup-household"
          name="householdName"
          className="text-input"
          type="text"
          required
          maxLength={SETUP_HOUSEHOLD_NAME_MAX}
          value={householdName}
          onInput={onFieldInput}
          aria-invalid={nameInvalid || undefined}
          aria-describedby={nameInvalid ? 'setup-household-error' : undefined}
          data-testid="household-name-input"
        />
        <FieldError id="setup-household-error" message={errors.householdName} />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="setup-secret">
          Setup code
        </label>
        <input
          id="setup-secret"
          name="setupSecret"
          className="text-input"
          type="password"
          autoComplete="off"
          required
          value={setupSecret}
          onInput={onFieldInput}
          aria-invalid={secretInvalid || undefined}
          aria-describedby={secretInvalid ? 'setup-secret-error' : undefined}
          data-testid="setup-secret-input"
        />
        <FieldError id="setup-secret-error" message={errors.setupSecret} />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="setup-email">
          {authMode === 'password' ? 'Admin email' : 'Your email'}
        </label>
        <input
          id="setup-email"
          name="email"
          className="text-input"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          value={email}
          onInput={onFieldInput}
          aria-invalid={emailInvalid || undefined}
          aria-describedby={emailInvalid ? 'setup-email-error' : undefined}
          data-testid="setup-email-input"
        />
        {authMode === 'password' ? (
          <p className="role-hint" data-testid="setup-email-hint">
            Required. This email is the admin account id, not optional.
          </p>
        ) : null}
        <FieldError id="setup-email-error" message={errors.email} />
      </div>

      {authMode === 'password' ? (
        <div className="field">
          <label className="field-label" htmlFor="setup-password">
            Admin password
          </label>
          <input
            id="setup-password"
            name="password"
            className="text-input"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            value={password}
            onInput={onFieldInput}
            aria-invalid={passwordInvalid || undefined}
            aria-describedby={passwordInvalid ? 'setup-password-error' : undefined}
            data-testid="setup-password-input"
          />
          <p className="role-hint">At least {PASSWORD_MIN_LENGTH} characters.</p>
          <FieldError id="setup-password-error" message={errors.password} />
        </div>
      ) : null}

      {siteKey ? (
        <div
          className="cf-turnstile"
          data-sitekey={siteKey}
          data-theme="auto"
          data-testid="turnstile"
        />
      ) : null}

      <button
        className="btn btn-primary"
        type="submit"
        disabled={pending}
        data-testid="setup-submit"
      >
        {pending ? 'Creating…' : 'Create household'}
      </button>

      {state.status === 'error' ? (
        <p className="login-error" role="alert" data-testid={`setup-error-${state.reason}`}>
          {errorCopy[state.reason]}
        </p>
      ) : (
        <p className="login-fine">
          You&rsquo;ll set up subjects next, then land on the parent dashboard.
        </p>
      )}
    </form>
  );
}
