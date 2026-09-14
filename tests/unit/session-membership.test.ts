import { describe, expect, it } from 'vitest';
import { sessionMembershipOk } from '@/lib/auth';
import type { Membership } from '@/lib/households';

function member(overrides: Partial<Membership> = {}): Membership {
  return {
    userId: 1,
    householdId: 1,
    role: 'student',
    email: 'alex@example.com',
    ...overrides,
  };
}

describe('sessionMembershipOk', () => {
  it('allows an empty session', () => {
    expect(sessionMembershipOk({}, null)).toBe(true);
  });

  it('rejects a signed-in session with no membership', () => {
    expect(sessionMembershipOk({ userId: 1, role: 'student' }, null)).toBe(false);
  });

  it('requires the cookie role to match household membership', () => {
    expect(sessionMembershipOk({ userId: 1, role: 'student' }, member({ role: 'student' }))).toBe(
      true,
    );
    expect(sessionMembershipOk({ userId: 1, role: 'parent' }, member({ role: 'admin' }))).toBe(
      true,
    );
    expect(sessionMembershipOk({ userId: 1, role: 'parent' }, member({ role: 'student' }))).toBe(
      false,
    );
    expect(sessionMembershipOk({ userId: 1, role: 'student' }, member({ role: 'parent' }))).toBe(
      false,
    );
  });
});
