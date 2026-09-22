'use client';

import Script from 'next/script';
import { startTransition, useActionState, useState, type ChangeEvent, type FormEvent } from 'react';
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
import type { AuthMode, ResolvedMailTransport } from '@/lib/auth-mode';
import { inviteCodeDestination, mailboxWhere, type MailboxDelivery } from '@/lib/mailbox-copy';
import {
  hasPasswordEntryFieldErrors,
  readPasswordEntryFields,
  validateInvitePasswordFields,
  type PasswordEntryFieldErrors,
} from '@/lib/password-entry-form';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_MISMATCH } from '@/lib/password-policy';
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
  password_mismatch: PASSWORD_MISMATCH,
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
  mailboxDelivery = 'inbox',
  codeDelivery = 'outbox',
}: {
  inviteToken: string;
  role: 'student' | 'parent';
  lockedEmail: string | null;
  siteKey?: string;
  authMode: AuthMode;
  mailboxDelivery?: MailboxDelivery;
  /** Effective transport from `resolveMailTransport()`. Password-invite copy only. */
  codeDelivery?: ResolvedMailTransport;
}) {
  if (authMode === 'password') {
    return (
      <PasswordInviteForm
        inviteToken={inviteToken}
        role={role}
        lockedEmail={lockedEmail}
        siteKey={siteKey}
        codeDelivery={codeDelivery}
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
      mailboxDelivery={mailboxDelivery}
    />
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p className="field-error" id={id} role="alert" data-testid={id}>
      {message}
    </p>
  );
}

type InviteStepErrors = PasswordEntryFieldErrors & { confirmPassword?: string };

function PasswordInviteForm({
  inviteToken,
  role,
  lockedEmail,
  siteKey,
  codeDelivery,
}: {
  inviteToken: string;
  role: 'student' | 'parent';
  lockedEmail: string | null;
  siteKey?: string;
  codeDelivery: ResolvedMailTransport;
}) {
  const [state, formAction, pending] = useActionState<AcceptInvitePasswordState, FormData>(
    acceptInviteWithPassword,
    { status: 'idle' },
  );
  const [editing, setEditing] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<InviteStepErrors>({});

  function readStep(formData: FormData): InviteStepErrors {
    const fields = readPasswordEntryFields(formData);
    const next: InviteStepErrors = { ...validateInvitePasswordFields(fields) };
    const confirm = String(formData.get('confirmPassword') ?? '');
    if (!next.password && fields.password !== confirm) {
      next.confirmPassword = PASSWORD_MISMATCH;
    }
    return next;
  }

  function onFieldInput(event: FormEvent<HTMLInputElement>) {
    if (!attempted) return;
    const form = event.currentTarget.form;
    if (!form) return;
    setFieldErrors(readStep(new FormData(form)));
  }

  function submit(formData: FormData) {
    const next = readStep(formData);
    setAttempted(true);
    setFieldErrors(next);
    if (hasPasswordEntryFieldErrors(next) || next.confirmPassword) return;
    setEditing(false);
    startTransition(() => {
      formAction(formData);
    });
  }

  // Keep the OTP screen closed while a replacement request is in flight so the
  // previous code cannot be submitted before the revoke lands.
  if (state.status === 'sent' && !editing && !pending) {
    return (
      <PasswordInviteOtpForm
        email={state.email}
        role={role}
        siteKey={siteKey}
        codeDelivery={codeDelivery}
        onBack={() => setEditing(true)}
      />
    );
  }

  const confirmError =
    fieldErrors.confirmPassword ??
    (state.status === 'error' && state.reason === 'password_mismatch'
      ? PASSWORD_MISMATCH
      : undefined);
  const passwordDescribedBy = [
    'invite-password-hint',
    fieldErrors.password ? 'invite-password-error' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <form
      className="screen login"
      noValidate
      data-testid="invite-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit(new FormData(event.currentTarget));
      }}
    >
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
        subtitle={`Choose a password. Next, enter the one-time code we send to ${inviteCodeDestination(codeDelivery)}.`}
      />
      <EmailField
        defaultEmail={lockedEmail ?? ''}
        locked={Boolean(lockedEmail)}
        invalid={Boolean(fieldErrors.email)}
        error={fieldErrors.email}
        onInput={onFieldInput}
      />
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
          onInput={onFieldInput}
          onChange={onFieldInput}
          aria-invalid={fieldErrors.password ? true : undefined}
          aria-describedby={passwordDescribedBy}
          data-testid="invite-password-input"
        />
        <p className="role-hint" id="invite-password-hint">
          At least {PASSWORD_MIN_LENGTH} characters (max {PASSWORD_MAX_LENGTH}).
        </p>
        <FieldError id="invite-password-error" message={fieldErrors.password} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="invite-confirm-password">
          Confirm password
        </label>
        <input
          id="invite-confirm-password"
          name="confirmPassword"
          className="text-input"
          type="password"
          autoComplete="new-password"
          required
          maxLength={PASSWORD_MAX_LENGTH}
          onInput={onFieldInput}
          onChange={onFieldInput}
          aria-invalid={confirmError ? true : undefined}
          aria-describedby={confirmError ? 'invite-confirm-error' : undefined}
          data-testid="invite-confirm-password-input"
        />
        <FieldError id="invite-confirm-error" message={confirmError} />
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
        disabled={pending}
        data-testid="invite-submit"
      >
        {MailIcon.lock} {pending ? 'Sending code…' : 'Send confirmation code'}
      </button>
      {state.status === 'sent' ? (
        <p className="login-fine" data-testid="invite-code-pending">
          A code is already in {inviteCodeDestination(codeDelivery)}. It still matches the password
          from that request. Send a new code to replace it if you want a different password.
        </p>
      ) : null}
      {state.status === 'error' && state.reason !== 'password_mismatch' ? (
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
  role,
  siteKey,
  codeDelivery,
  onBack,
}: {
  email: string;
  role: 'student' | 'parent';
  siteKey?: string;
  codeDelivery: ResolvedMailTransport;
  onBack: () => void;
}) {
  const [otpState, otpAction, otpPending] = useActionState<CompletePasswordInviteState, FormData>(
    completePasswordInvite,
    { status: 'idle' },
  );
  const [code, setCode] = useState('');
  const where = inviteCodeDestination(codeDelivery);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const digits = String(formData.get('code') ?? '')
      .replace(/\D/g, '')
      .slice(0, 6);
    if (!/^\d{6}$/.test(digits)) return;
    formData.set('code', digits);
    startTransition(() => {
      otpAction(formData);
    });
  }

  return (
    <form className="screen login" data-testid="invite-otp-form" onSubmit={submit}>
      {siteKey ? (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          async
          defer
          strategy="afterInteractive"
        />
      ) : null}
      <div className="sent-state" role="status">
        <span className="sent-icon">{MailIcon.inbox}</span>
        <h1 className="sent-title">Enter your confirmation code</h1>
        <p className="sent-note" data-testid="invite-otp-handoff">
          The password you chose is waiting on this code. We sent a 6-digit code to <b>{email}</b>.
          Enter it to finish joining. It is in {where}.
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
      <p className="login-fine" data-testid="invite-otp-resend-hint">
        Need a new code? Send one again below. The new code replaces this one, and you enter the
        password again so they match.
      </p>
      <button
        type="button"
        className="btn btn-quiet"
        onClick={onBack}
        data-testid="invite-otp-back"
      >
        Send a new code
      </button>
    </form>
  );
}

function ChallengeInviteForm({
  inviteToken,
  role,
  lockedEmail,
  siteKey,
  authMode,
  mailboxDelivery,
}: {
  inviteToken: string;
  role: 'student' | 'parent';
  lockedEmail: string | null;
  siteKey?: string;
  authMode: Exclude<AuthMode, 'password'>;
  mailboxDelivery: MailboxDelivery;
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
              Check {mailboxWhere(mailboxDelivery)}.
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
      <EmailField
        defaultEmail={lockedEmail ?? ''}
        locked={Boolean(lockedEmail)}
        value={email}
        onChange={setEmail}
      />
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
  defaultEmail,
  locked,
  value,
  onChange,
  onInput,
  invalid,
  error,
}: {
  defaultEmail: string;
  locked: boolean;
  value?: string;
  onChange?: (value: string) => void;
  onInput?: (event: FormEvent<HTMLInputElement>) => void;
  invalid?: boolean;
  error?: string;
}) {
  const controlled = value !== undefined;
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
        {...(controlled
          ? {
              value,
              onChange: (event: ChangeEvent<HTMLInputElement>) => onChange?.(event.target.value),
            }
          : { defaultValue: defaultEmail })}
        onInput={onInput}
        aria-invalid={invalid || undefined}
        aria-describedby={error ? 'invite-email-error' : undefined}
        data-testid="invite-email-input"
      />
      {error ? (
        <p
          className="field-error"
          id="invite-email-error"
          role="alert"
          data-testid="invite-email-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
