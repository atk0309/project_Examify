'use server';

import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { revokeHouseholdInvite } from '@/lib/households';

const inputSchema = z.object({
  inviteId: z.coerce.number().int().positive(),
});

export type RevokeInviteResult = { ok: true } | { ok: false; reason: 'forbidden' | 'not_found' };

export async function revokeInvite(formData: FormData): Promise<RevokeInviteResult> {
  const session = await getSession();
  if (!session.userId || session.role !== 'parent') {
    return { ok: false, reason: 'forbidden' };
  }

  const parsed = inputSchema.safeParse({ inviteId: formData.get('inviteId') });
  if (!parsed.success) return { ok: false, reason: 'not_found' };

  return revokeHouseholdInvite(session.userId, parsed.data.inviteId);
}
