'use client';

import Script from 'next/script';
import { useActionState, useState } from 'react';
import { bootstrapHouseholdAction, type BootstrapState } from '@/actions/bootstrapHousehold';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const errorCopy: Record<Exclude<BootstrapState, { status: 'idle' }>['reason'], string> = {
  invalid: 'Please enter a household name and a valid email address.',
  already_setup: 'This instance is already set up. Sign in instead.',
  captcha: 'Verification failed. Please try again.',
  rate_limited: 'Too many attempts from your network. Try again later.',
  forbidden: 'That setup code is not valid.',
};

export function SetupForm({ siteKey }: { siteKey?: string }) {
  const [state, formAction, pending] = useActionState<BootstrapState, FormData>(
    bootstrapHouseholdAction,
    { status: 'idle' },
  );
  const [email, setEmail] = useState('');
  const [name, setName] = useState('Our family');
  const [setupSecret, setSetupSecret] = useState('');
  const valid =
    EMAIL_RE.test(email.trim()) && name.trim().length > 0 && setupSecret.trim().length > 0;

  return (
    <form className="screen login" action={formAction} data-testid="setup-form">
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
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="household-name-input"
        />
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
          onChange={(e) => setSetupSecret(e.target.value)}
          data-testid="setup-secret-input"
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="setup-email">
          Your email
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
          onChange={(e) => setEmail(e.target.value)}
          data-testid="setup-email-input"
        />
      </div>

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
        disabled={!valid || pending}
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
          You&rsquo;ll land on the parent dashboard and can invite family next.
        </p>
      )}
    </form>
  );
}
