import { describe, expect, it } from 'vitest';
import type { ResolvedMailTransport } from '@/lib/auth-mode';
import { inviteCodeDestination, mailboxWhere } from '@/lib/mailbox-copy';

const TRANSPORTS: ResolvedMailTransport[] = ['resend', 'smtp', 'outbox'];

describe('inviteCodeDestination', () => {
  it('gives Resend, SMTP, and the local outbox their own phrases', () => {
    const phrases = Object.fromEntries(
      TRANSPORTS.map((transport) => [transport, inviteCodeDestination(transport)]),
    ) as Record<ResolvedMailTransport, string>;

    expect(phrases.resend).toBe('your email inbox, through Resend');
    expect(phrases.smtp).toBe("your email inbox, through this host's mail server");
    expect(phrases.outbox).toBe('the local mail outbox on this host');

    expect(phrases.resend).not.toMatch(/outbox|mail server/i);
    expect(phrases.smtp).not.toMatch(/Resend|outbox/);
    expect(phrases.outbox).not.toMatch(/inbox|Resend|mail server/);
    expect(new Set(Object.values(phrases)).size).toBe(3);
  });
});

describe('mailboxWhere', () => {
  it('keeps the inbox versus outbox phrases used outside password invites', () => {
    expect(mailboxWhere('inbox')).toBe('your inbox');
    expect(mailboxWhere('outbox')).toBe('the mail outbox on this host');
  });
});
