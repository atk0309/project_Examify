'use server';

import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { env } from '@/lib/env';
import { createHouseholdInvite } from '@/lib/households';

const inputSchema = z.object({
  role: z.enum(['student', 'parent']),
  email: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().toLowerCase().email().optional(),
  ),
});

export type CreateInviteResult =
  | { ok: true; url: string; role: 'student' | 'parent'; email: string | null; expiresAt: number }
  | { ok: false; reason: 'forbidden' | 'invalid' };

export async function createInvite(formData: FormData): Promise<CreateInviteResult> {
  const session = await getSession();
  if (!session.userId || session.role !== 'parent') {
    return { ok: false, reason: 'forbidden' };
  }

  const rawEmail = formData.get('email');
  const parsed = inputSchema.safeParse({
    role: formData.get('role'),
    email: typeof rawEmail === 'string' ? rawEmail : '',
  });
  if (!parsed.success) return { ok: false, reason: 'invalid' };

  const created = createHouseholdInvite({
    actorUserId: session.userId,
    role: parsed.data.role,
    email: parsed.data.email || null,
  });
  if (!created.ok) return created;

  const url = `${env.SITE_URL}/invite/${encodeURIComponent(created.token)}`;
  return {
    ok: true,
    url,
    role: created.invite.role,
    email: created.invite.email,
    expiresAt: created.invite.expiresAt,
  };
}
