'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createInvite } from '@/actions/createInvite';
import { removeMember } from '@/actions/removeMember';
import { revokeInvite } from '@/actions/revokeInvite';
import type { HouseholdMemberView, PendingInvite } from '@/lib/household-types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function HouseholdInvites({
  pending,
  members = [],
}: {
  pending: PendingInvite[];
  members?: HouseholdMemberView[];
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [role, setRole] = useState<'student' | 'parent'>('student');
  const [email, setEmail] = useState('');
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<number | null>(null);
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
            : result.reason === 'rate_limited'
              ? 'Too many invites from your network. Try again later.'
              : 'Could not create that invite. Parent invites need an email.',
        );
        return;
      }
      setCreatedUrl(result.url);
      setCreatedId(result.id);
      setEmail('');
      router.refresh();
    });
  };

  const onRevoke = (inviteId: number) => {
    setError(null);
    startTransition(async () => {
      const data = new FormData();
      data.set('inviteId', String(inviteId));
      const result = await revokeInvite(data);
      if (!result.ok) {
        setError(
          result.reason === 'forbidden'
            ? 'You cannot revoke that invite.'
            : 'Could not revoke that invite.',
        );
        return;
      }
      if (createdId === inviteId) {
        setCreatedUrl(null);
        setCreatedId(null);
        setCopied(false);
      }
      router.refresh();
    });
  };

  const onRemove = (userId: number) => {
    setError(null);
    startTransition(async () => {
      const data = new FormData();
      data.set('userId', String(userId));
      const result = await removeMember(data);
      if (!result.ok) {
        setError(
          result.reason === 'forbidden'
            ? 'You cannot remove that person.'
            : 'Could not remove that person.',
        );
        return;
      }
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
        Share a link to add a student or another parent. Student links may be open; parent invites
        must be locked to one email.
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
          {role === 'parent' ? 'Lock to email (required)' : 'Lock to email (optional)'}
        </label>
        <input
          id="invite-lock-email"
          name="email"
          className="text-input"
          type="email"
          inputMode="email"
          required={role === 'parent'}
          placeholder={role === 'parent' ? 'parent@example.com' : 'leave blank for an open link'}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid="invite-lock-email"
        />
        <button
          className="btn btn-primary"
          type="submit"
          disabled={busy || (role === 'parent' && !EMAIL_RE.test(email.trim()))}
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

      {members.length > 0 ? (
        <ul className="invite-list" data-testid="household-members">
          {members.map((member) => (
            <li key={member.userId} className="invite-row" data-testid="household-member">
              <div>
                <strong>{member.label}</strong>
                <span className="invite-meta">
                  {member.role} · {member.email}
                </span>
              </div>
              {member.canRemove ? (
                <button
                  type="button"
                  className="btn btn-quiet invite-revoke"
                  disabled={busy}
                  onClick={() => onRemove(member.userId)}
                  data-testid="remove-member"
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
