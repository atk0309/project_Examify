'use client';

import Script from 'next/script';
import { useActionState, useState } from 'react';
import {
  acceptInviteWithPassword,
  type AcceptInvitePasswordState,
} from '@/actions/acceptInviteWithPassword';
import {
  completePasswordInvite,
  type CompletePasswordInviteState,
} from '@/actions/completePasswordInvite';
import { requestInviteLink, type RequestInviteLinkState } from '@/actions/requestInviteLink';
import { verifyLocalOtp, type VerifyLocalOtpState } from '@/actions/verifyLocalOtp';
import type { AuthMode } from '@/lib/auth-mode';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { ExplicitTurnstile } from './ExplicitTurnstile';
import { MailIcon, RoleIcon } from './icons';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const challengeErrorCopy: Record<
  Exclude<RequestInviteLinkState, { status: 'idle' | 'sent' }>['reason'],
  string
> = {
  invalid: 'Please enter a valid email address.',
  captcha: 'Verification failed. Please try again.',
  rate_limited: 'Too many attempts from your network. Try again later.',
  send_failed: 'We could not send the email. Please try again in a moment.',
  invite_invalid: 'This invite is invalid or has expired.',
};

const passwordErrorCopy: Record<
  Exclude<AcceptInvitePasswordState, { status: 'idle' | 'sent' }>['reason'],
  string
> = {
  invalid: 'Could not join with those details.',
  captcha: 'Verification failed. Please try again.',
  rate_limited: 'Too many attempts from your network. Try again later.',
  invite_invalid: 'This invite is invalid or has expired.',
  send_failed: 'We could not send a confirmation code. Ask the host to configure mail.',
};

const otpErrorCopy: Record<Exclude<VerifyLocalOtpState, { status: 'idle' }>['reason'], string> = {
  invalid: 'That code did not work. Try again.',
  captcha: 'Verification failed. Please try again.',
  rate_limited: 'Too many attempts from your network. Try again later.',
};

export function InviteAcceptForm({
  inviteToken,
  role,
  lockedEmail,
  siteKey,
  authMode,
}: {
  inviteToken: string;
  role: 'student' | 'parent';
  lockedEmail: string | null;
  siteKey?: string;
  authMode: AuthMode;
}) {
  if (authMode === 'password') {
    return (
      <PasswordInviteForm
        inviteToken={inviteToken}
        role={role}
        lockedEmail={lockedEmail}
        siteKey={siteKey}
      />
    );
  }
  return (
    <ChallengeInviteForm
      inviteToken={inviteToken}
      role={role}
      lockedEmail={lockedEmail}
      siteKey={siteKey}
      authMode={authMode}
    />
  );
}

function PasswordInviteForm({
  inviteToken,
  role,
  lockedEmail,
  siteKey,
}: {
  inviteToken: string;
  role: 'student' | 'parent';
  lockedEmail: string | null;
  siteKey?: string;
}) {
  const [state, formAction, pending] = useActionState<AcceptInvitePasswordState, FormData>(
    acceptInviteWithPassword,
    { status: 'idle' },
  );
  const [email, setEmail] = useState(lockedEmail ?? '');
  const [password, setPassword] = useState('');
  const valid =
    EMAIL_RE.test(email.trim()) &&
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH;

  if (state.status === 'sent') {
    return (
      <PasswordInviteOtpForm
        email={state.email}
        password={password}
        role={role}
        siteKey={siteKey}
      />
    );
  }

  return (
    <form className="screen login" action={formAction} data-testid="invite-form">
      {siteKey ? (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          async
          defer
          strategy="afterInteractive"
        />
      ) : null}
      <InviteHeader
        role={role}
        subtitle="Choose a password, then confirm a one-time code we send to this email."
      />
      <EmailField email={email} locked={Boolean(lockedEmail)} onChange={setEmail} />
      <div className="field">
        <label className="field-label" htmlFor="invite-password">
          Password
        </label>
        <input
          id="invite-password"
          name="password"
          className="text-input"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="invite-password-input"
        />
        <p className="role-hint">At least {PASSWORD_MIN_LENGTH} characters.</p>
      </div>
      <input type="hidden" name="inviteToken" value={inviteToken} />
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
        data-testid="invite-submit"
      >
        {MailIcon.lock} {pending ? 'Sending code…' : 'Send confirmation code'}
      </button>
      {state.status === 'error' ? (
        <p className="login-error" role="alert" data-testid={`invite-error-${state.reason}`}>
          {passwordErrorCopy[state.reason]}
        </p>
      ) : (
        <p className="login-fine">
          {MailIcon.lock}
          {lockedEmail
            ? 'This link is a secret. We send a one-time code to the locked email — typing the address is not mailbox proof.'
            : 'This is an open invite. Anyone who has the link can start a join for an email they control — they still have to prove that mailbox.'}
        </p>
      )}
    </form>
  );
}

function PasswordInviteOtpForm({
  email,
  password,
  role,
  siteKey,
}: {
  email: string;
  password: string;
  role: 'student' | 'parent';
  siteKey?: string;
}) {
  const [otpState, otpAction, otpPending] = useActionState<CompletePasswordInviteState, FormData>(
    completePasswordInvite,
    { status: 'idle' },
  );
  const [code, setCode] = useState('');

  return (
    <form className="screen login" action={otpAction} data-testid="invite-otp-form">
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
          We sent a 6-digit code to <b>{email}</b>. Joining finishes only after you enter it. Check
          the mail outbox on this host, or your inbox if email is configured.
        </p>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="invite-password-otp">
          Confirmation code
        </label>
        <input
          id="invite-password-otp"
          name="code"
          className="text-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          data-testid="otp-input"
        />
      </div>
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="role" value={role} />
      <input type="hidden" name="password" value={password} />
      {siteKey ? <ExplicitTurnstile siteKey={siteKey} /> : null}
      <button
        className="btn btn-primary"
        type="submit"
        disabled={code.length !== 6 || otpPending}
        data-testid="otp-submit"
      >
        {MailIcon.lock} {otpPending ? 'Joining…' : 'Join household'}
      </button>
      {otpState.status === 'error' ? (
        <p className="login-error" role="alert" data-testid={`otp-error-${otpState.reason}`}>
          {otpErrorCopy[otpState.reason]}
        </p>
      ) : (
        <p className="login-fine">
          {MailIcon.lock}
          The code proves this mailbox. The invite link alone is not enough.
        </p>
      )}
    </form>
  );
}

function ChallengeInviteForm({
  inviteToken,
  role,
  lockedEmail,
  siteKey,
  authMode,
}: {
  inviteToken: string;
  role: 'student' | 'parent';
  lockedEmail: string | null;
  siteKey?: string;
  authMode: Exclude<AuthMode, 'password'>;
}) {
  const [state, formAction, pending] = useActionState<RequestInviteLinkState, FormData>(
    requestInviteLink,
    { status: 'idle' },
  );
  const [otpState, otpAction, otpPending] = useActionState<VerifyLocalOtpState, FormData>(
    verifyLocalOtp,
    { status: 'idle' },
  );
  const [email, setEmail] = useState(lockedEmail ?? '');
  const [code, setCode] = useState('');
  const valid = EMAIL_RE.test(email.trim());
  const otpMode = authMode === 'local-otp';

  if (state.status === 'sent') {
    if (otpMode) {
      return (
        <form className="screen login" action={otpAction} data-testid="invite-otp-form">
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
              If <b>{state.email}</b> can join this household, we&rsquo;ve issued a 6-digit code.
              Check the mail outbox on this host, or your inbox if email is configured.
            </p>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="invite-otp">
              Sign-in code
            </label>
            <input
              id="invite-otp"
              name="code"
              className="text-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={6}
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
            {MailIcon.lock} {otpPending ? 'Checking…' : 'Join household'}
          </button>
          {otpState.status === 'error' ? (
            <p className="login-error" role="alert" data-testid={`otp-error-${otpState.reason}`}>
              {otpErrorCopy[otpState.reason]}
            </p>
          ) : null}
        </form>
      );
    }

    return (
      <div className="screen login">
        <div className="sent-state" role="status">
          <span className="sent-icon">{MailIcon.inbox}</span>
          <h1 className="sent-title">Check your inbox</h1>
          <p className="sent-note">
            If <b>{state.email}</b> can join this household, we&rsquo;ve sent a secure sign-in link.
            Open it on this device — it&rsquo;s good for 15 minutes.
          </p>
          <span className="sent-email-chip">
            {MailIcon.at}
            {state.email}
          </span>
        </div>
      </div>
    );
  }

  return (
    <form className="screen login" action={formAction} data-testid="invite-form">
      {siteKey ? (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          async
          defer
          strategy="afterInteractive"
        />
      ) : null}
      <InviteHeader
        role={role}
        subtitle={
          otpMode
            ? "You're joining as a member. We'll issue a one-time code — there's no password."
            : "You're joining as a member. We'll email a sign-in link — there's no password."
        }
      />
      <EmailField email={email} locked={Boolean(lockedEmail)} onChange={setEmail} />
      <input type="hidden" name="inviteToken" value={inviteToken} />
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
        data-testid="invite-submit"
      >
        {MailIcon.send} {pending ? 'Sending…' : otpMode ? 'Send sign-in code' : 'Send magic link'}
      </button>
      {state.status === 'error' ? (
        <p className="login-error" role="alert" data-testid={`invite-error-${state.reason}`}>
          {challengeErrorCopy[state.reason]}
        </p>
      ) : (
        <p className="login-fine">
          {MailIcon.lock}
          Only this invite can add you to the household.
        </p>
      )}
    </form>
  );
}

function InviteHeader({ role, subtitle }: { role: 'student' | 'parent'; subtitle: string }) {
  return (
    <>
      <div className="login-head">
        <span className="brand-mark">E</span>
        <h1 className="brand-word">Join the household</h1>
        <p className="login-sub">{subtitle}</p>
      </div>
      <div className="field">
        <label className="field-label">Role</label>
        <div className="role-seg" role="radiogroup" aria-label="Invite role">
          <button type="button" role="radio" aria-checked className="role-opt active" disabled>
            {RoleIcon[role]}
            {role === 'student' ? 'Student' : 'Parent'}
          </button>
        </div>
      </div>
    </>
  );
}

function EmailField({
  email,
  locked,
  onChange,
}: {
  email: string;
  locked: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor="invite-email">
        Email address
      </label>
      <input
        id="invite-email"
        name="email"
        className="text-input"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        readOnly={locked}
        placeholder="you@example.com"
        value={email}
        onChange={(e) => onChange(e.target.value)}
        data-testid="invite-email-input"
      />
    </div>
  );
}
