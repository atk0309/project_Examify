'use client';

import Script from 'next/script';
import {
  startTransition,
  useActionState,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { bootstrapHouseholdAction, type BootstrapState } from '@/actions/bootstrapHousehold';
import type { AuthMode } from '@/lib/auth-mode';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_MISMATCH } from '@/lib/password-policy';
import {
  captureSilentSetupSnapshot,
  hasSetupFieldErrors,
  isFieldMappedBootstrapReason,
  readSetupFields,
  recoverSetupFieldsAfterRemount,
  resolveSetupFieldErrors,
  SETUP_DEFAULT_HOUSEHOLD_NAME,
  SETUP_HOUSEHOLD_NAME_MAX,
  setupFieldErrorsFromServer,
  setupFieldsEqual,
  type SetupFieldEdited,
  type SetupFieldErrors,
  type SetupFieldKey,
  type SetupFormFields,
  validateSetupFields,
  writeSetupFields,
} from '@/lib/setup-form';

const errorCopy: Record<Exclude<BootstrapState, { status: 'idle' }>['reason'], string> = {
  invalid: 'Please enter a household name and a valid email address.',
  already_setup: 'This instance is already set up. Sign in instead.',
  captcha: 'Verification failed. Please try again.',
  rate_limited: 'Too many attempts from your network. Try again later.',
  forbidden: 'That setup code is not valid.',
  password_mismatch: PASSWORD_MISMATCH,
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
  const lastFieldsRef = useRef<SetupFormFields | null>(null);
  const inputTickRef = useRef(0);
  const appliedInputTickRef = useRef(0);
  const dispatchIdRef = useRef(0);
  const appliedIdRef = useRef(0);
  const [attempted, setAttempted] = useState(false);
  const [localErrors, setLocalErrors] = useState<SetupFieldErrors>({});
  const [successfullyEdited, setSuccessfullyEdited] = useState<SetupFieldEdited>({});

  useLayoutEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const live = readSetupFields(new FormData(form));
    if (inputTickRef.current !== appliedInputTickRef.current) {
      appliedInputTickRef.current = inputTickRef.current;
      lastFieldsRef.current = live;
    } else {
      const recovered = recoverSetupFieldsAfterRemount(live, lastFieldsRef.current);
      if (!setupFieldsEqual(recovered, live)) {
        writeSetupFields(form, recovered);
        lastFieldsRef.current = recovered;
      } else {
        lastFieldsRef.current = captureSilentSetupSnapshot(live, lastFieldsRef.current);
      }
    }
    if (pending) return;
    if (dispatchIdRef.current === appliedIdRef.current) return;
    appliedIdRef.current = dispatchIdRef.current;
    if (lastFieldsRef.current) writeSetupFields(form, lastFieldsRef.current);
  }, [pending, state, siteKey]);

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const capture = () => {
      lastFieldsRef.current = captureSilentSetupSnapshot(
        readSetupFields(new FormData(form)),
        lastFieldsRef.current,
      );
    };
    capture();
    let frames = 0;
    let raf = 0;
    const tick = () => {
      capture();
      frames += 1;
      if (frames < 16) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Keep watching after the first-paint rAF window — password managers
    // often fill after Turnstile's script/site-key delay.
    const interval = window.setInterval(capture, 250);
    form.addEventListener('animationstart', capture);
    form.addEventListener('focusin', capture);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(interval);
      form.removeEventListener('animationstart', capture);
      form.removeEventListener('focusin', capture);
    };
  }, [siteKey]);

  const fieldErrors = resolveSetupFieldErrors({
    local: localErrors,
    server:
      state.status === 'error' && !pending
        ? setupFieldErrorsFromServer(state.reason, authMode)
        : {},
    successfullyEdited,
  });

  function onFieldInput(event: FormEvent<HTMLInputElement>) {
    const form = event.currentTarget.form ?? formRef.current;
    if (!form) return;
    inputTickRef.current += 1;
    const fields = readSetupFields(new FormData(form));
    lastFieldsRef.current = fields;
    appliedInputTickRef.current = inputTickRef.current;
    const name = event.currentTarget.name as SetupFieldKey;
    if (!attempted) return;
    const nextLocal = validateSetupFields(fields, authMode);
    setLocalErrors(nextLocal);
    if (!nextLocal[name]) {
      setSuccessfullyEdited((prev) => ({ ...prev, [name]: true }));
    }
  }

  function submit(formData: FormData) {
    const fields = readSetupFields(formData);
    lastFieldsRef.current = fields;
    const nextErrors = validateSetupFields(fields, authMode);
    setAttempted(true);
    setSuccessfullyEdited({});
    setLocalErrors(nextErrors);
    if (hasSetupFieldErrors(nextErrors)) return;
    dispatchIdRef.current += 1;
    startTransition(() => {
      formAction(formData);
    });
  }

  const emailInvalid = Boolean(fieldErrors.email);
  const nameInvalid = Boolean(fieldErrors.householdName);
  const secretInvalid = Boolean(fieldErrors.setupSecret);
  const passwordInvalid = Boolean(fieldErrors.password);
  const confirmInvalid = Boolean(fieldErrors.confirmPassword);
  const passwordDescribedBy = ['setup-password-hint', passwordInvalid ? 'setup-password-error' : '']
    .filter(Boolean)
    .join(' ');
  const confirmDescribedBy = ['setup-confirm-hint', confirmInvalid ? 'setup-confirm-error' : '']
    .filter(Boolean)
    .join(' ');
  const showFormBanner = state.status === 'error' && !isFieldMappedBootstrapReason(state.reason);

  return (
    <form
      ref={formRef}
      className="screen login login-setup"
      noValidate
      data-testid="setup-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit(new FormData(event.currentTarget));
      }}
    >
      <div hidden={!siteKey} aria-hidden={!siteKey || undefined}>
        {siteKey ? (
          <Script
            src="https://challenges.cloudflare.com/turnstile/v0/api.js"
            async
            defer
            strategy="afterInteractive"
          />
        ) : null}
      </div>
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
          defaultValue={SETUP_DEFAULT_HOUSEHOLD_NAME}
          onInput={onFieldInput}
          onChange={onFieldInput}
          aria-invalid={nameInvalid || undefined}
          aria-describedby={nameInvalid ? 'setup-household-error' : undefined}
          data-testid="household-name-input"
        />
        <FieldError id="setup-household-error" message={fieldErrors.householdName} />
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
          onInput={onFieldInput}
          onChange={onFieldInput}
          aria-invalid={secretInvalid || undefined}
          aria-describedby={secretInvalid ? 'setup-secret-error' : undefined}
          data-testid="setup-secret-input"
        />
        <FieldError id="setup-secret-error" message={fieldErrors.setupSecret} />
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
          onInput={onFieldInput}
          onChange={onFieldInput}
          aria-invalid={emailInvalid || undefined}
          aria-describedby={emailInvalid ? 'setup-email-error' : undefined}
          data-testid="setup-email-input"
        />
        {authMode === 'password' ? (
          <p className="role-hint" data-testid="setup-email-hint">
            Required. This email is the admin account id, not optional.
          </p>
        ) : null}
        <FieldError id="setup-email-error" message={fieldErrors.email} />
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
            onInput={onFieldInput}
            onChange={onFieldInput}
            aria-invalid={passwordInvalid || undefined}
            aria-describedby={passwordDescribedBy}
            data-testid="setup-password-input"
          />
          <p className="role-hint" id="setup-password-hint">
            At least {PASSWORD_MIN_LENGTH} characters (max {PASSWORD_MAX_LENGTH}).
          </p>
          <FieldError id="setup-password-error" message={fieldErrors.password} />
        </div>
      ) : null}

      {authMode === 'password' ? (
        <div className="field">
          <label className="field-label" htmlFor="setup-confirm-password">
            Confirm admin password
          </label>
          <input
            id="setup-confirm-password"
            name="confirmPassword"
            className="text-input"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            onInput={onFieldInput}
            onChange={onFieldInput}
            aria-invalid={confirmInvalid || undefined}
            aria-describedby={confirmDescribedBy}
            data-testid="setup-confirm-password-input"
          />
          <p className="role-hint" id="setup-confirm-hint">
            Type the same password again.
          </p>
          <FieldError id="setup-confirm-error" message={fieldErrors.confirmPassword} />
        </div>
      ) : null}

      <div data-testid="setup-turnstile-slot">
        {siteKey ? (
          <div
            className="cf-turnstile"
            data-sitekey={siteKey}
            data-theme="auto"
            data-testid="turnstile"
          />
        ) : null}
      </div>

      <button
        className="btn btn-primary"
        type="submit"
        disabled={pending}
        data-testid="setup-submit"
      >
        {pending ? 'Creating…' : 'Create household'}
      </button>

      {showFormBanner ? (
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
