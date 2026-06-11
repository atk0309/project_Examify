'use client';

/* ============================================================================
   EXAMIFY — LOGIN  (magic-link, role-gated)
   UI for the passwordless flow. On submit it calls the `requestMagicLink`
   server action, which verifies Turnstile, checks the role's env allowlist,
   and (only for approved emails) emails a one-time sign-in link. The response
   is intentionally generic so the allowlist can't be enumerated.
   ========================================================================== */
import Script from 'next/script';
import { useActionState, useState } from 'react';
import { requestMagicLink, type RequestMagicLinkState } from '@/actions/requestMagicLink';
import { MailIcon, RoleIcon } from './icons';

type Role = 'student' | 'parent';

const ROLES: { id: Role; label: string; hint: string }[] = [
  { id: 'student', label: 'Student', hint: 'Practising for your own exams.' },
  { id: 'parent', label: 'Parent', hint: "Supporting your child's revision." },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const errorCopy: Record<
  Exclude<RequestMagicLinkState, { status: 'idle' | 'sent' }>['reason'],
  string
> = {
  invalid: 'Please enter a valid email address.',
  captcha: 'Verification failed. Please try again.',
  rate_limited: 'Too many attempts from your network. Try again later.',
  send_failed: 'We could not send the email. Please try again in a moment.',
};

export function LoginForm({ siteKey }: { siteKey: string }) {
  const [state, formAction, pending] = useActionState<RequestMagicLinkState, FormData>(
    requestMagicLink,
    { status: 'idle' },
  );
  const [role, setRole] = useState<Role>('student');
  const [email, setEmail] = useState('');
  // `useActionState` has no reset, and the "sent" screen lives on /signin, so a
  // <Link href="/signin"> is a no-op soft nav that leaves status === 'sent'. Track
  // a local dismissal instead; a fresh submit clears it (see `submit` wrapper).
  const [dismissed, setDismissed] = useState(false);
  const valid = EMAIL_RE.test(email.trim());
  const roleObj = ROLES.find((r) => r.id === role)!;

  const submit = (formData: FormData) => {
    setDismissed(false);
    formAction(formData);
  };

  if (state.status === 'sent' && !dismissed) {
    return (
      <div className="screen login">
        <div className="sent-state" role="status">
          <span className="sent-icon">{MailIcon.inbox}</span>
          <h1 className="sent-title">Check your inbox</h1>
          <p className="sent-note">
            If <b>{state.email}</b> is approved, we’ve sent a secure sign-in link. Open it on this
            device to continue — it’s good for 15 minutes and there’s no password.
          </p>
          <span className="sent-email-chip">
            {MailIcon.at}
            {state.email}
          </span>
          <div className="mt-6 flex flex-col gap-[var(--sp-2)]">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setDismissed(true);
                setEmail('');
              }}
            >
              Use a different email
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form className="screen login" action={submit} data-testid="signin-form">
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js"
        async
        defer
        strategy="afterInteractive"
      />
      <div className="login-head">
        <span className="brand-mark">E</span>
        <h1 className="brand-word">Examify</h1>
        <p className="login-sub">
          Sign in to start practising. We’ll email you a secure link — there’s no password to
          remember.
        </p>
      </div>

      <div className="field">
        <label className="field-label">I am a</label>
        <div className="role-seg" role="radiogroup" aria-label="Choose your role">
          {ROLES.map((r) => (
            <button
              type="button"
              key={r.id}
              role="radio"
              aria-checked={role === r.id}
              className={'role-opt' + (role === r.id ? ' active' : '')}
              onClick={() => setRole(r.id)}
            >
              {RoleIcon[r.id]}
              {r.label}
            </button>
          ))}
        </div>
        <p className="role-hint">{roleObj.hint}</p>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="login-email">
          Email address
        </label>
        <input
          id="login-email"
          name="email"
          className="text-input"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid="email-input"
        />
      </div>

      {/* Role travels with the form; Turnstile widget injects its own response
          input, and this hidden fallback is what Playwright fills when the
          widget can't load (see SignInForm note retained in docs). */}
      <input type="hidden" name="role" value={role} />
      <div
        className="cf-turnstile"
        data-sitekey={siteKey}
        data-theme="auto"
        data-testid="turnstile"
      />
      <input type="hidden" name="cf-turnstile-response" data-testid="turnstile-response" />

      <button
        className="btn btn-primary"
        type="submit"
        disabled={!valid || pending}
        data-testid="signin-submit"
      >
        {MailIcon.send} {pending ? 'Sending…' : 'Send magic link'}
      </button>

      {state.status === 'error' ? (
        <p className="login-error" role="alert" data-testid={`signin-error-${state.reason}`}>
          {errorCopy[state.reason]}
        </p>
      ) : (
        <p className="login-fine">
          {MailIcon.lock}
          Secure, passwordless sign-in. Only approved {role} emails can log in.
        </p>
      )}
    </form>
  );
}
