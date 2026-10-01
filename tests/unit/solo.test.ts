import { createHmac } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', async () => {
  const schema = await import('@/lib/db/schema');
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: path.join(process.cwd(), 'src/lib/db/migrations') });
  return { db: drizzle(sqlite, { schema }), schema };
});
const session = vi.hoisted(() => ({
  save: vi.fn(),
  userId: undefined as number | undefined,
  email: undefined as string | undefined,
  role: undefined as string | undefined,
  studentMode: false,
  solo: false,
  sessionVersion: undefined as number | undefined,
}));
vi.mock('@/lib/auth', () => ({ getRawSession: vi.fn(async () => session) }));

import { db, schema } from '@/lib/db';
import { env } from '@/lib/env';
import { bootstrapSoloSession, getSoloIdentity } from '@/lib/solo';
import {
  canInvite,
  createHouseholdInvite,
  bootstrapHousehold,
  importLegacyFamiliesIfNeeded,
} from '@/lib/households';
import { POST } from '@/app/api/solo/session/route';

const previous = { ...env };
const key = '1'.repeat(64);
function signedToken(nonce = '4'.repeat(64), secret = key) {
  return nonce + '.' + createHmac('sha256', secret).update(nonce).digest('hex');
}
const token = signedToken();
beforeEach(() => {
  Object.assign(env, {
    EXAMIFY_MODE: 'solo',
    SITE_URL: 'http://127.0.0.1:41234',
    EXAMIFY_SOLO_LAUNCH_TOKEN: key,
    EXAMIFY_SOLO_TRANSPORT_SECRET: '2'.repeat(64),
  });
  for (const table of [
    schema.soloProfiles,
    schema.soloLaunchTokens,
    schema.magicTokens,
    schema.examAttempts,
    schema.examSessions,
    schema.householdInvites,
    schema.householdMembers,
    schema.households,
    schema.users,
  ])
    db.delete(table).run();
  session.save.mockReset();
  session.userId = undefined;
});
afterAll(() => Object.assign(env, previous));

describe('dedicated solo identity', () => {
  it('rejects replay A after a distinct capability B has also been redeemed', () => {
    expect(bootstrapSoloSession(token).ok).toBe(true);
    expect(bootstrapSoloSession(signedToken('6'.repeat(64))).ok).toBe(true);
    expect(bootstrapSoloSession(token)).toEqual({ ok: false, reason: 'used' });
    expect(db.select().from(schema.soloLaunchTokens).all()).toHaveLength(2);
  });
  it('creates only one synthetic admin with optional onboarding and no mailbox proof/password', () => {
    const result = bootstrapSoloSession(token);
    expect(result.ok).toBe(true);
    expect(getSoloIdentity()?.userId).toBe(db.select().from(schema.users).get()?.id);
    expect(db.select().from(schema.users).get()).toMatchObject({
      email: 'learner@solo.invalid',
      emailVerifiedAt: null,
      passwordHash: null,
    });
    expect(db.select().from(schema.householdMembers).get()?.role).toBe('admin');
    expect(db.select().from(schema.households).get()?.onboardingComplete).toBe(false);
    expect(bootstrapSoloSession(token)).toEqual({ ok: false, reason: 'used' });
    env.EXAMIFY_SOLO_LAUNCH_TOKEN = '3'.repeat(64);
    expect(bootstrapSoloSession(signedToken('5'.repeat(64), '3'.repeat(64)))).toEqual(result);
    expect(bootstrapSoloSession(token)).toEqual({ ok: false, reason: 'forbidden' });
    expect(db.select().from(schema.users).all()).toHaveLength(1);
  });
  it('requires the capability and explicit solo mode before any write', () => {
    expect(bootstrapSoloSession('wrong')).toEqual({ ok: false, reason: 'forbidden' });
    env.EXAMIFY_MODE = 'household';
    expect(bootstrapSoloSession(token)).toEqual({ ok: false, reason: 'forbidden' });
    expect(db.select().from(schema.users).all()).toHaveLength(0);
  });
  it('refuses to adopt or modify an existing household or orphan user', () => {
    const user = db
      .insert(schema.users)
      .values({ email: 'existing@example.test' })
      .returning()
      .get();
    expect(bootstrapSoloSession(token)).toEqual({ ok: false, reason: 'existing_data' });
    expect(db.select().from(schema.users).all()).toEqual([user]);
    expect(db.select().from(schema.soloProfiles).all()).toHaveLength(0);
    db.insert(schema.households).values({ name: 'Existing family' }).run();
    expect(bootstrapSoloSession(token)).toEqual({ ok: false, reason: 'existing_data' });
    expect(db.select().from(schema.households).get()?.name).toBe('Existing family');
  });
  it('refuses a marker with changed membership or extra household data', () => {
    bootstrapSoloSession(token);
    db.insert(schema.users).values({ email: 'other@example.test' }).run();
    expect(getSoloIdentity()).toBeNull();
    expect(bootstrapSoloSession(token)).toEqual({ ok: false, reason: 'existing_data' });
  });
  it('disables household claiming, invites and legacy import in solo mode', () => {
    bootstrapSoloSession(token);
    const id = getSoloIdentity()!.userId;
    expect(canInvite(id)).toBe(false);
    expect(createHouseholdInvite({ actorUserId: id, role: 'student' })).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(bootstrapHousehold({ email: 'other@example.test', householdName: 'Other' }).ok).toBe(
      false,
    );
    expect(importLegacyFamiliesIfNeeded()).toEqual({ imported: 0, skipped: 0 });
  });
});

function request(headers: Record<string, string> = {}, body = JSON.stringify({ token })) {
  return new Request('http://127.0.0.1:41234/api/solo/session', {
    method: 'POST',
    body,
    headers: {
      host: '127.0.0.1:41234',
      origin: 'http://127.0.0.1:41234',
      'x-examify-solo-transport': '2'.repeat(64),
      'content-type': 'application/json',
      ...headers,
    },
  });
}
describe('POST /api/solo/session', () => {
  it('writes an admin student-mode session only after one-time bootstrap', async () => {
    expect((await POST(request())).status).toBe(200);
    expect(session).toMatchObject({
      userId: getSoloIdentity()!.userId,
      role: 'parent',
      studentMode: true,
      solo: true,
      sessionVersion: 0,
    });
    expect(session.save).toHaveBeenCalledTimes(1);
    expect((await POST(request())).status).toBe(409);
    expect(session.save).toHaveBeenCalledTimes(1);
  });
  it('rejects foreign-origin and direct requests without creating identity', async () => {
    expect((await POST(request({ origin: 'https://attacker.example' }))).status).toBe(403);
    expect((await POST(request({ 'x-examify-solo-transport': '' }))).status).toBe(403);
    expect((await POST(request({}, JSON.stringify({ token: 'bad' })))).status).toBe(403);
    expect(getSoloIdentity()).toBeNull();
    expect(session.save).not.toHaveBeenCalled();
  });
  it('rejects malformed or oversized input and exposes no household route in remote mode', async () => {
    expect((await POST(request({}, 'broken'))).status).toBe(400);
    expect((await POST(request({}, 'x'.repeat(257)))).status).toBe(400);
    env.EXAMIFY_MODE = 'household';
    expect((await POST(request())).status).toBe(404);
  });
  it('returns a bounded failure without leaking a thrown path or capability', async () => {
    session.save.mockRejectedValueOnce(new Error('/private/path/' + token));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, reason: 'unavailable' });
  });
});
