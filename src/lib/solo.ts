import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db, schema } from './db';
import { env, isSoloMode } from './env';
import { validSoloLaunchToken, soloCapabilityHash } from './solo-security';

const SOLO_EMAIL = 'learner@solo.invalid';
type Connection = Pick<typeof db, 'select'>;

export type SoloIdentity = {
  userId: number;
  householdId: number;
  email: string;
  sessionVersion: number;
};

/** Read-only, including on the first render. The bootstrap POST owns creation. */
export function getSoloIdentity(connection: Connection = db): SoloIdentity | null {
  const row = connection
    .select({
      userId: schema.users.id,
      householdId: schema.households.id,
      email: schema.users.email,
      sessionVersion: schema.users.sessionVersion,
    })
    .from(schema.soloProfiles)
    .innerJoin(schema.users, eq(schema.soloProfiles.userId, schema.users.id))
    .innerJoin(schema.households, eq(schema.soloProfiles.householdId, schema.households.id))
    .innerJoin(
      schema.householdMembers,
      and(
        eq(schema.householdMembers.userId, schema.users.id),
        eq(schema.householdMembers.householdId, schema.households.id),
        eq(schema.householdMembers.role, 'admin'),
      ),
    )
    .where(eq(schema.soloProfiles.id, 1))
    .get();
  if (!row || row.email !== SOLO_EMAIL) return null;
  // A marker may never silently bless an expanded or imported household database.
  if (
    connection.select().from(schema.users).limit(2).all().length !== 1 ||
    connection.select().from(schema.households).limit(2).all().length !== 1 ||
    connection.select().from(schema.householdMembers).limit(2).all().length !== 1 ||
    connection.select().from(schema.householdInvites).limit(1).get()
  )
    return null;
  return row;
}

export type SoloBootstrapResult =
  | { ok: true; identity: SoloIdentity }
  | { ok: false; reason: 'forbidden' | 'used' | 'existing_data' };

/** Consume one launch capability and initialize only a completely empty identity store. */
export function bootstrapSoloSession(token: string): SoloBootstrapResult {
  if (!isSoloMode() || !validSoloLaunchToken(token, env.EXAMIFY_SOLO_LAUNCH_TOKEN)) {
    return { ok: false, reason: 'forbidden' };
  }
  const tokenHash = soloCapabilityHash(token);
  const launchKeyHash = soloCapabilityHash(env.EXAMIFY_SOLO_LAUNCH_TOKEN!);
  return db.transaction(
    (tx) => {
      const marker = tx
        .select()
        .from(schema.soloProfiles)
        .where(eq(schema.soloProfiles.id, 1))
        .get();
      if (marker) {
        const identity = getSoloIdentity(tx);
        if (!identity) return { ok: false, reason: 'existing_data' as const };
        // Old-process signatures fail before DB access, so their consumed
        // nonces can be retired safely when a new launcher key is first used.
        if (marker.launchKeyHash !== launchKeyHash) {
          tx.delete(schema.soloLaunchTokens).run();
          tx.update(schema.soloProfiles)
            .set({ launchKeyHash })
            .where(eq(schema.soloProfiles.id, 1))
            .run();
        }
        if (
          tx
            .select()
            .from(schema.soloLaunchTokens)
            .where(eq(schema.soloLaunchTokens.tokenHash, tokenHash))
            .get()
        ) {
          return { ok: false, reason: 'used' as const };
        }
        tx.insert(schema.soloLaunchTokens).values({ tokenHash }).run();
        return { ok: true, identity };
      }
      // No adopting a household, orphan user, old attempt, invite or sign-in token.
      const occupied = [
        schema.users,
        schema.households,
        schema.householdMembers,
        schema.householdInvites,
        schema.magicTokens,
        schema.examAttempts,
        schema.examSessions,
        schema.soloProfiles,
        schema.soloLaunchTokens,
      ].some((table) => Boolean(tx.select().from(table).limit(1).get()));
      if (occupied) return { ok: false, reason: 'existing_data' as const };
      const user = tx.insert(schema.users).values({ email: SOLO_EMAIL }).returning().get();
      const household = tx
        .insert(schema.households)
        .values({ name: 'My learning', onboardingComplete: false })
        .returning()
        .get();
      tx.insert(schema.householdMembers)
        .values({ userId: user.id, householdId: household.id, role: 'admin' })
        .run();
      tx.insert(schema.soloProfiles)
        .values({
          id: 1,
          userId: user.id,
          householdId: household.id,
          launchKeyHash,
        })
        .run();
      tx.insert(schema.soloLaunchTokens).values({ tokenHash }).run();
      return {
        ok: true,
        identity: {
          userId: user.id,
          householdId: household.id,
          email: user.email,
          sessionVersion: user.sessionVersion,
        },
      };
    },
    { behavior: 'immediate' },
  );
}
