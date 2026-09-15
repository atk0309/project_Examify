'use client';

/* ============================================================================
   EXAMIFY — LOGIN
   UI follows AUTH_MODE: magic-link, local OTP, or password. After Turnstile
   (when on) the server always returns a generic outcome so membership cannot
   be enumerated.
   ========================================================================== */
import Script from 'next/script';
import { useActionState, useState } from 'react';
import { requestMagicLink, type RequestMagicLinkState } from '@/actions/requestMagicLink';
import { signInWithPassword, type SignInPasswordState } from '@/actions/signInWithPassword';
import { verifyLocalOtp, type VerifyLocalOtpState } from '@/actions/verifyLocalOtp';
import type { AuthMode } from '@/lib/auth-mode';
import { PASSWORD_MAX_LENGTH } from '@/lib/password-policy';
import { ExplicitTurnstile } from './ExplicitTurnstile';
import { MailIcon, RoleIcon } from './icons';

type Role = 'student' | 'parent';

const ROLES: { id: Role; label: string; hint: string }[] = [
  { id: 'student', label: 'Student', hint: 'Practising for your own exams.' },
  { id: 'parent', label: 'Parent', hint: "Supporting your child's revision." },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const challengeErrorCopy: Record<
  Exclude<RequestMagicLinkState, { status: 'idle' | 'sent' }>['reason'],
  string
> = {
  invalid: 'Please enter a valid email address.',
  captcha: 'Verification failed. Please try again.',
  rate_limited: 'Too many attempts from your network. Try again later.',
  send_failed: 'We could not send the email. Please try again in a moment.',
};

const passwordErrorCopy: Record<
  Exclude<SignInPasswordState, { status: 'idle' }>['reason'],
  string
> = {
  invalid: 'Email or password is incorrect.',
  captcha: 'Verification failed. Please try again.',
  rate_limited: 'Too many attempts from your network. Try again later.',
};

const otpErrorCopy: Record<Exclude<VerifyLocalOtpState, { status: 'idle' }>['reason'], string> = {
  invalid: 'That code did not work. Try again.',
  captcha: 'Verification failed. Please try again.',
  rate_limited: 'Too many attempts from your network. Try again later.',
};

function Turnstile({ siteKey }: { siteKey?: string }) {
  if (!siteKey) return null;
  return (
    <div
      className="cf-turnstile"
      data-sitekey={siteKey}
      data-theme="auto"
      data-testid="turnstile"
    />
  );
}

function RolePicker({ role, onChange }: { role: Role; onChange: (role: Role) => void }) {
  const roleObj = ROLES.find((r) => r.id === role)!;
  return (
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
            onClick={() => onChange(r.id)}
          >
            {RoleIcon[r.id]}
            {r.label}
          </button>
        ))}
      </div>
      <p className="role-hint">{roleObj.hint}</p>
    </div>
  );
}

export function LoginForm({ siteKey, authMode }: { siteKey?: string; authMode: AuthMode }) {
  if (authMode === 'password') {
    return <PasswordLoginForm siteKey={siteKey} />;
  }
  return <ChallengeLoginForm siteKey={siteKey} authMode={authMode} />;
}

function PasswordLoginForm({ siteKey }: { siteKey?: string }) {
  const [state, formAction, pending] = useActionState<SignInPasswordState, FormData>(
    signInWithPassword,
    { status: 'idle' },
  );
  const [role, setRole] = useState<Role>('student');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const valid =
    EMAIL_RE.test(email.trim()) && password.length > 0 && password.length <= PASSWORD_MAX_LENGTH;

  return (
    <form className="screen login" action={formAction} data-testid="signin-form">
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
        <h1 className="brand-word">Examify</h1>
        <p className="login-sub">
          Sign in with the email and password for this household. Only invited members can log in.
        </p>
      </div>

      <RolePicker role={role} onChange={setRole} />

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
          autoComplete="username"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid="email-input"
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          name="password"
          className="text-input"
          type="password"
          autoComplete="current-password"
          required
          maxLength={PASSWORD_MAX_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="password-input"
        />
      </div>

      <input type="hidden" name="role" value={role} />
      <Turnstile siteKey={siteKey} />

      <button
        className="btn btn-primary"
        type="submit"
        disabled={!valid || pending}
        data-testid="signin-submit"
      >
        {MailIcon.lock} {pending ? 'Signing in…' : 'Sign in'}
      </button>

      {state.status === 'error' ? (
        <p className="login-error" role="alert" data-testid={`signin-error-${state.reason}`}>
          {passwordErrorCopy[state.reason]}
        </p>
      ) : (
        <p className="login-fine">
          {MailIcon.lock}
          Secure sign-in. Only household members can log in.
        </p>
      )}
    </form>
  );
}

function ChallengeLoginForm({
  siteKey,
  authMode,
}: {
  siteKey?: string;
  authMode: Exclude<AuthMode, 'password'>;
}) {
  const [state, formAction, pending] = useActionState<RequestMagicLinkState, FormData>(
    requestMagicLink,
    { status: 'idle' },
  );
  const [otpState, otpAction, otpPending] = useActionState<VerifyLocalOtpState, FormData>(
    verifyLocalOtp,
    { status: 'idle' },
  );
  const [role, setRole] = useState<Role>('student');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const valid = EMAIL_RE.test(email.trim());
  const otpMode = authMode === 'local-otp';

  const submit = (formData: FormData) => {
    setDismissed(false);
    formAction(formData);
  };

  if (state.status === 'sent' && !dismissed) {
    if (otpMode) {
      return (
        <form className="screen login" action={otpAction} data-testid="otp-form">
          {siteKey ? (
            <Script
              src="https://challenges.cloudflare.com/turnstile/v0/api.js"
              async
              defer
              strategy="afterInteractive"
            />
          ) : null}
          <div className="sent-state">
            <span className="sent-icon">{MailIcon.inbox}</span>
            <h1 className="sent-title">Enter your code</h1>
            <p className="sent-note">
              If <b>{state.email}</b> is a household member, we&rsquo;ve issued a 6-digit sign-in
              code (check the mail outbox on this host, or your inbox if email is configured). It is
              good for 15 minutes.
            </p>
            <span className="sent-email-chip">
              {MailIcon.at}
              {state.email}
            </span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="login-otp">
              Sign-in code
            </label>
            <input
              id="login-otp"
              name="code"
              className="text-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={6}
              pattern="\d{6}"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              data-testid="otp-input"
            />
          </div>
          <input type="hidden" name="email" value={state.email} />
          <input type="hidden" name="role" value={role} />
          {siteKey ? <ExplicitTurnstile siteKey={siteKey} /> : null}
          <button
            className="btn btn-primary"
            type="submit"
            disabled={code.length !== 6 || otpPending}
            data-testid="otp-submit"
          >
            {MailIcon.lock} {otpPending ? 'Checking…' : 'Sign in'}
          </button>
          {otpState.status === 'error' ? (
            <p className="login-error" role="alert" data-testid={`otp-error-${otpState.reason}`}>
              {otpErrorCopy[otpState.reason]}
            </p>
          ) : null}
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setDismissed(true);
              setEmail('');
              setCode('');
            }}
          >
            Use a different email
          </button>
        </form>
      );
    }

    return (
      <div className="screen login">
        <div className="sent-state" role="status">
          <span className="sent-icon">{MailIcon.inbox}</span>
          <h1 className="sent-title">Check your inbox</h1>
          <p className="sent-note">
            If <b>{state.email}</b> is approved, we&rsquo;ve sent a secure sign-in link. Open it on
            this device to continue — it&rsquo;s good for 15 minutes and there&rsquo;s no password.
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
        <h1 className="brand-word">Examify</h1>
        <p className="login-sub">
          {otpMode
            ? 'Sign in to start practising. We’ll issue a one-time code — no password to remember.'
            : 'Sign in to start practising. We’ll email you a secure link — there’s no password to remember.'}
        </p>
      </div>

      <RolePicker role={role} onChange={setRole} />

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

      <input type="hidden" name="role" value={role} />
      <Turnstile siteKey={siteKey} />

      <button
        className="btn btn-primary"
        type="submit"
        disabled={!valid || pending}
        data-testid="signin-submit"
      >
        {MailIcon.send} {pending ? 'Sending…' : otpMode ? 'Send sign-in code' : 'Send magic link'}
      </button>

      {state.status === 'error' ? (
        <p className="login-error" role="alert" data-testid={`signin-error-${state.reason}`}>
          {challengeErrorCopy[state.reason]}
        </p>
      ) : (
        <p className="login-fine">
          {MailIcon.lock}
          {otpMode
            ? 'Secure, passwordless sign-in. Only household members can log in.'
            : 'Secure, passwordless sign-in. Only household members can log in.'}
        </p>
      )}
    </form>
  );
}
