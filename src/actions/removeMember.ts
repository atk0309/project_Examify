'use server';

import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { removeHouseholdMember } from '@/lib/households';

const inputSchema = z.object({
  userId: z.coerce.number().int().positive(),
});

export type RemoveMemberResult = { ok: true } | { ok: false; reason: 'forbidden' | 'not_found' };

export async function removeMember(formData: FormData): Promise<RemoveMemberResult> {
  const session = await getSession();
  if (!session.userId || session.role !== 'parent') {
    return { ok: false, reason: 'forbidden' };
  }

  const parsed = inputSchema.safeParse({ userId: formData.get('userId') });
  if (!parsed.success) return { ok: false, reason: 'not_found' };

  return removeHouseholdMember(session.userId, parsed.data.userId);
}
