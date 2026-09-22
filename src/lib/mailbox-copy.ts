/** Where this host delivers mailbox codes. Instance-wide — not a per-address signal. */
export type MailboxDelivery = 'inbox' | 'outbox';

export function mailboxWhere(delivery: MailboxDelivery): string {
  return delivery === 'outbox' ? 'the mail outbox on this host' : 'your inbox';
}
