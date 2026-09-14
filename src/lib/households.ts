import 'server-only';
import crypto from 'node:crypto';
import { and, eq, gte, isNull } from 'drizzle-orm';
import { db, schema } from './db';
import { parseFamilies } from './families';
import type { HouseholdRole, InviteRole } from './db/schema';
import type { PendingInvite } from './household-types';

export type { PendingInvite } from './household-types';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HOUSEHOLD_NAME_MAX = 80;

export type Membership = {
  userId: number;
  householdId: number;
  role: HouseholdRole;
  email: string;
};

export type PublicInvite = {
  id: number;
  role: InviteRole;
  email: string | null;
  expiresAt: number;
};

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateInviteToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/** Friendly first-name-ish label from an email local part ("alex@…" → "Alex"). */
export function labelFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  const first = local.split(/[._+-]/)[0] ?? local;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function countHouseholds(): number {
  const row = db.select({ id: schema.households.id }).from(schema.households).limit(1).get();
  return row ? 1 : 0;
}

/**
 * Optional one-shot import for existing Railway / env-JSON deploys. Reads
 * raw `process.env.FAMILIES` (not the env.ts schema — leftover JSON must
 * not crash boot). Runs at most once per process, and only when the DB
 * has no households yet. New installs leave FAMILIES unset and use
 * first-run bootstrap instead.
 */
let legacyImportAttempted = false;

export function importLegacyFamiliesIfNeeded(): { imported: number; error?: string } {
  if (legacyImportAttempted) return { imported: 0 };
  legacyImportAttempted = true;

  if (countHouseholds() > 0) return { imported: 0 };

  const raw = process.env.FAMILIES;
  if (raw === undefined || raw.trim() === '' || raw.trim() === '[]') {
    return { imported: 0 };
  }

  const parsed = parseFamilies(raw);
  if (!parsed.ok) {
    console.warn(`[households] FAMILIES import skipped: ${parsed.error}`);
    return { imported: 0, error: parsed.error };
  }
  if (parsed.families.length === 0) return { imported: 0 };

  return db.transaction((tx) => {
    const existing = tx.select({ id: schema.households.id }).from(schema.households).limit(1).get();
    if (existing) return { imported: 0 };

    let imported = 0;
    for (const family of parsed.families) {
      const name = `Family of ${labelFromEmail(family.child)}`;
      const household = tx.insert(schema.households).values({ name }).returning().get();
      if (!household) throw new Error('failed to create household');

      const child = getOrCreateUser(tx, family.child);
      tx.insert(schema.householdMembers)
        .values({ householdId: household.id, userId: child.id, role: 'student' })
        .run();

      family.parents.forEach((parentEmail, index) => {
        const parent = getOrCreateUser(tx, parentEmail);
        tx.insert(schema.householdMembers)
          .values({
            householdId: household.id,
            userId: parent.id,
            role: index === 0 ? 'admin' : 'parent',
          })
          .run();
      });
      imported += 1;
    }
    return { imported };
  });
}

/** Reset the one-shot import latch — tests only. */
export function resetLegacyImportLatch(): void {
  legacyImportAttempted = false;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function getOrCreateUser(tx: Tx, email: string): { id: number; email: string } {
  const normalised = normaliseEmail(email);
  const existing = tx.select().from(schema.users).where(eq(schema.users.email, normalised)).get();
  if (existing) return { id: existing.id, email: existing.email };
  const inserted = tx
    .insert(schema.users)
    .values({ email: normalised })
    .returning({ id: schema.users.id, email: schema.users.email })
    .get();
  if (!inserted) throw new Error('failed to create user');
  return inserted;
}

export function hasAnyHousehold(): boolean {
  importLegacyFamiliesIfNeeded();
  return countHouseholds() > 0;
}

export function getMembershipForUser(userId: number): Membership | null {
  importLegacyFamiliesIfNeeded();
  const row = db
    .select({
      userId: schema.householdMembers.userId,
      householdId: schema.householdMembers.householdId,
      role: schema.householdMembers.role,
      email: schema.users.email,
    })
    .from(schema.householdMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.householdMembers.userId))
    .where(eq(schema.householdMembers.userId, userId))
    .get();
  return row ?? null;
}

export function getMembershipForEmail(email: string): Membership | null {
  importLegacyFamiliesIfNeeded();
  const normalised = normaliseEmail(email);
  if (!normalised) return null;
  const row = db
    .select({
      userId: schema.householdMembers.userId,
      householdId: schema.householdMembers.householdId,
      role: schema.householdMembers.role,
      email: schema.users.email,
    })
    .from(schema.users)
    .innerJoin(schema.householdMembers, eq(schema.householdMembers.userId, schema.users.id))
    .where(eq(schema.users.email, normalised))
    .get();
  return row ?? null;
}

export function isParentLike(role: HouseholdRole): boolean {
  return role === 'admin' || role === 'parent';
}

export function canInvite(userId: number): boolean {
  const membership = getMembershipForUser(userId);
  return Boolean(membership && isParentLike(membership.role));
}

/** True iff `email` is a household member allowed to sign in as `role`. */
export function isHouseholdEmailAllowed(role: 'student' | 'parent', email: string): boolean {
  const membership = getMembershipForEmail(email);
  if (!membership) return false;
  if (role === 'student') return membership.role === 'student';
  return isParentLike(membership.role);
}

export type BootstrapResult =
  | { ok: true; userId: number; email: string; householdId: number }
  | { ok: false; reason: 'already_setup' | 'invalid' };

export function bootstrapHousehold(input: {
  email: string;
  householdName: string;
}): BootstrapResult {
  importLegacyFamiliesIfNeeded();
  const email = normaliseEmail(input.email);
  const name = input.householdName.trim();
  if (!email || !name || name.length > HOUSEHOLD_NAME_MAX) {
    return { ok: false, reason: 'invalid' };
  }

  return db.transaction((tx) => {
    const existing = tx.select({ id: schema.households.id }).from(schema.households).limit(1).get();
    if (existing) return { ok: false, reason: 'already_setup' as const };

    const user = getOrCreateUser(tx, email);
    tx.update(schema.users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(schema.users.id, user.id))
      .run();

    const household = tx.insert(schema.households).values({ name }).returning().get();
    if (!household) throw new Error('failed to create household');

    tx.insert(schema.householdMembers)
      .values({ householdId: household.id, userId: user.id, role: 'admin' })
      .run();

    return { ok: true, userId: user.id, email, householdId: household.id };
  });
}

export type CreateInviteResult =
  | { ok: true; token: string; invite: PendingInvite }
  | { ok: false; reason: 'forbidden' | 'invalid' };

export function createHouseholdInvite(input: {
  actorUserId: number;
  role: InviteRole;
  email?: string | null;
  now?: number;
}): CreateInviteResult {
  const membership = getMembershipForUser(input.actorUserId);
  if (!membership || !isParentLike(membership.role)) {
    return { ok: false, reason: 'forbidden' };
  }
  if (input.role !== 'parent' && input.role !== 'student') {
    return { ok: false, reason: 'invalid' };
  }
  const email = input.email ? normaliseEmail(input.email) : null;
  if (input.email && !email) return { ok: false, reason: 'invalid' };

  const now = input.now ?? Date.now();
  const { token, tokenHash } = generateInviteToken();
  const expiresAt = new Date(now + INVITE_TTL_MS);

  const row = db
    .insert(schema.householdInvites)
    .values({
      householdId: membership.householdId,
      createdByUserId: input.actorUserId,
      role: input.role,
      tokenHash,
      email,
      expiresAt,
    })
    .returning()
    .get();
  if (!row) throw new Error('failed to create invite');

  return {
    ok: true,
    token,
    invite: {
      id: row.id,
      householdId: row.householdId,
      role: row.role,
      email: row.email,
      expiresAt: row.expiresAt.getTime(),
    },
  };
}

export function listPendingInvites(householdId: number, now = Date.now()): PendingInvite[] {
  const rows = db
    .select()
    .from(schema.householdInvites)
    .where(
      and(
        eq(schema.householdInvites.householdId, householdId),
        isNull(schema.householdInvites.consumedAt),
        gte(schema.householdInvites.expiresAt, new Date(now)),
      ),
    )
    .all();
  return rows.map((row) => ({
    id: row.id,
    householdId: row.householdId,
    role: row.role,
    email: row.email,
    expiresAt: row.expiresAt.getTime(),
  }));
}

export function revokeHouseholdInvite(
  actorUserId: number,
  inviteId: number,
): { ok: true } | { ok: false; reason: 'forbidden' | 'not_found' } {
  const membership = getMembershipForUser(actorUserId);
  if (!membership || !isParentLike(membership.role)) {
    return { ok: false, reason: 'forbidden' };
  }
  const row = db
    .select()
    .from(schema.householdInvites)
    .where(
      and(
        eq(schema.householdInvites.id, inviteId),
        eq(schema.householdInvites.householdId, membership.householdId),
      ),
    )
    .get();
  if (!row) return { ok: false, reason: 'not_found' };
  db.delete(schema.householdInvites).where(eq(schema.householdInvites.id, inviteId)).run();
  return { ok: true };
}

export function lookupInvite(token: string, now = Date.now()): PublicInvite | null {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = db
    .select()
    .from(schema.householdInvites)
    .where(
      and(
        eq(schema.householdInvites.tokenHash, tokenHash),
        isNull(schema.householdInvites.consumedAt),
        gte(schema.householdInvites.expiresAt, new Date(now)),
      ),
    )
    .get();
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    email: row.email,
    expiresAt: row.expiresAt.getTime(),
  };
}

/**
 * Whether this email may receive a magic link for this invite. Unknown /
 * mismatched emails return false so the action can still show the generic
 * `sent` copy (no enumeration on email-locked invites).
 */
export function emailMayAcceptInvite(invite: PublicInvite, email: string): boolean {
  const normalised = normaliseEmail(email);
  if (!normalised) return false;
  if (getMembershipForEmail(normalised)) return false;
  if (invite.email && invite.email !== normalised) return false;
  return true;
}

export type AttachInviteResult = { ok: true } | { ok: false; reason: 'invite-invalid' };

/**
 * Attach the user to the invite's household and mark the invite consumed.
 * Runs inside the magic-token consume transaction so a partial accept
 * cannot issue a session without membership.
 */
export function attachMembershipFromInvite(
  tx: Tx,
  inviteId: number,
  userId: number,
  email: string,
  now = Date.now(),
): AttachInviteResult {
  const invite = tx
    .select()
    .from(schema.householdInvites)
    .where(
      and(
        eq(schema.householdInvites.id, inviteId),
        isNull(schema.householdInvites.consumedAt),
        gte(schema.householdInvites.expiresAt, new Date(now)),
      ),
    )
    .get();
  if (!invite) return { ok: false, reason: 'invite-invalid' };
  if (invite.email && invite.email !== normaliseEmail(email)) {
    return { ok: false, reason: 'invite-invalid' };
  }

  const already = tx
    .select({ id: schema.householdMembers.id })
    .from(schema.householdMembers)
    .where(eq(schema.householdMembers.userId, userId))
    .get();
  if (already) return { ok: false, reason: 'invite-invalid' };

  tx.insert(schema.householdMembers)
    .values({ householdId: invite.householdId, userId, role: invite.role })
    .run();
  tx.update(schema.householdInvites)
    .set({ consumedAt: new Date(now) })
    .where(eq(schema.householdInvites.id, inviteId))
    .run();
  return { ok: true };
}

/** Students in the same household as this parent/admin — the privacy boundary. */
export function studentEmailsForParent(parentEmail: string): string[] {
  const membership = getMembershipForEmail(parentEmail);
  if (!membership || !isParentLike(membership.role)) return [];
  const rows = db
    .select({ email: schema.users.email })
    .from(schema.householdMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.householdMembers.userId))
    .where(
      and(
        eq(schema.householdMembers.householdId, membership.householdId),
        eq(schema.householdMembers.role, 'student'),
      ),
    )
    .all();
  return rows.map((row) => row.email);
}
