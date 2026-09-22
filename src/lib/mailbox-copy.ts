import type { ResolvedMailTransport } from '@/lib/auth-mode';

/** Where this host delivers mailbox codes. Instance-wide — not a per-address signal. */
export type MailboxDelivery = 'inbox' | 'outbox';

export function mailboxWhere(delivery: MailboxDelivery): string {
  return delivery === 'outbox' ? 'the mail outbox on this host' : 'your inbox';
}

/**
 * Where a password-invite confirmation code lands.
 * Follows `resolveMailTransport()`: Resend, SMTP, and the local outbox
 * each get their own phrase. No secrets and no per-address signal.
 */
export function inviteCodeDestination(transport: ResolvedMailTransport): string {
  switch (transport) {
    case 'resend':
      return 'your email inbox, through Resend';
    case 'smtp':
      return "your email inbox, through this host's mail server";
    case 'outbox':
      return 'the local mail outbox on this host';
  }
}
