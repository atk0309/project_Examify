'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createInvite } from '@/actions/createInvite';
import { revokeInvite } from '@/actions/revokeInvite';
import type { PendingInvite } from '@/lib/household-types';

export function HouseholdInvites({ pending }: { pending: PendingInvite[] }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [role, setRole] = useState<'student' | 'parent'>('student');
  const [email, setEmail] = useState('');
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const onCreate = (formData: FormData) => {
    setError(null);
    setCopied(false);
    startTransition(async () => {
      const result = await createInvite(formData);
      if (!result.ok) {
        setError(
          result.reason === 'forbidden'
            ? 'You cannot create invites.'
            : 'Could not create that invite.',
        );
        return;
      }
      setCreatedUrl(result.url);
      setEmail('');
      router.refresh();
    });
  };

  const onRevoke = (inviteId: number) => {
    startTransition(async () => {
      const data = new FormData();
      data.set('inviteId', String(inviteId));
      await revokeInvite(data);
      router.refresh();
    });
  };

  const copyUrl = async () => {
    if (!createdUrl) return;
    try {
      await navigator.clipboard.writeText(createdUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="progress-view" data-testid="household-invites">
      <p className="eyebrow">Household</p>
      <h2 className="display-title" style={{ fontSize: 'var(--fs-h2)' }}>
        Invite family
      </h2>
      <p className="subtitle">
        Share a link to add a student or another parent to this household. They sign in with a magic
        link — nothing to put in env.
      </p>

      <form action={onCreate} className="invite-create" data-testid="create-invite-form">
        <div className="role-seg" role="radiogroup" aria-label="Invite role">
          {(['student', 'parent'] as const).map((id) => (
            <button
              type="button"
              key={id}
              role="radio"
              aria-checked={role === id}
              className={'role-opt' + (role === id ? ' active' : '')}
              onClick={() => setRole(id)}
            >
              {id === 'student' ? 'Student' : 'Parent'}
            </button>
          ))}
        </div>
        <input type="hidden" name="role" value={role} />
        <label className="field-label" htmlFor="invite-lock-email">
          Lock to email (optional)
        </label>
        <input
          id="invite-lock-email"
          name="email"
          className="text-input"
          type="email"
          inputMode="email"
          placeholder="leave blank for an open link"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid="invite-lock-email"
        />
        <button
          className="btn btn-primary"
          type="submit"
          disabled={busy}
          data-testid="create-invite"
        >
          {busy ? 'Creating…' : 'Create invite link'}
        </button>
      </form>

      {createdUrl ? (
        <div className="invite-created" data-testid="invite-created">
          <label className="field-label" htmlFor="invite-url">
            Share this link
          </label>
          <input
            id="invite-url"
            className="text-input"
            readOnly
            value={createdUrl}
            data-testid="invite-url"
          />
          <button
            className="btn btn-quiet"
            type="button"
            onClick={copyUrl}
            data-testid="copy-invite"
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      {pending.length > 0 ? (
        <ul className="invite-list">
          {pending.map((invite) => (
            <li key={invite.id} className="invite-row" data-testid="pending-invite">
              <div>
                <strong>{invite.role === 'student' ? 'Student' : 'Parent'}</strong>
                <span className="invite-meta">
                  {invite.email ? invite.email : 'Open link'} · expires{' '}
                  {new Date(invite.expiresAt).toLocaleDateString()}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-quiet invite-revoke"
                disabled={busy}
                onClick={() => onRevoke(invite.id)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="login-fine">No pending invites.</p>
      )}
    </section>
  );
}
