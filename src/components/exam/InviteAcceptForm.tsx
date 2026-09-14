'use client';

import Script from 'next/script';
import { useActionState, useState } from 'react';
import { requestInviteLink, type RequestInviteLinkState } from '@/actions/requestInviteLink';
import { MailIcon, RoleIcon } from './icons';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const errorCopy: Record<
  Exclude<RequestInviteLinkState, { status: 'idle' | 'sent' }>['reason'],
  string
> = {
  invalid: 'Please enter a valid email address.',
  captcha: 'Verification failed. Please try again.',
  rate_limited: 'Too many attempts from your network. Try again later.',
  send_failed: 'We could not send the email. Please try again in a moment.',
  invite_invalid: 'This invite is invalid or has expired.',
};

export function InviteAcceptForm({
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
  const [state, formAction, pending] = useActionState<RequestInviteLinkState, FormData>(
    requestInviteLink,
    { status: 'idle' },
  );
  const [email, setEmail] = useState(lockedEmail ?? '');
  const valid = EMAIL_RE.test(email.trim());

  if (state.status === 'sent') {
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
      <div className="login-head">
        <span className="brand-mark">E</span>
        <h1 className="brand-word">Join the household</h1>
        <p className="login-sub">
          You&rsquo;re joining as a {role}. We&rsquo;ll email a sign-in link — there&rsquo;s no
          password.
        </p>
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
          readOnly={Boolean(lockedEmail)}
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid="invite-email-input"
        />
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
        {MailIcon.send} {pending ? 'Sending…' : 'Send magic link'}
      </button>

      {state.status === 'error' ? (
        <p className="login-error" role="alert" data-testid={`invite-error-${state.reason}`}>
          {errorCopy[state.reason]}
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
