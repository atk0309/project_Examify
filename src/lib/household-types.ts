/** Client-safe household types (no DB / server-only imports). */

export type InviteRole = 'parent' | 'student';

export type PendingInvite = {
  id: number;
  householdId: number;
  role: InviteRole;
  email: string | null;
  expiresAt: number;
};

export type HouseholdMemberView = {
  userId: number;
  email: string;
  role: 'admin' | 'parent' | 'student';
  label: string;
  canRemove: boolean;
};
