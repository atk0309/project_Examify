import { afterEach, describe, expect, it } from 'vitest';
import { isAllowedEmail } from '@/lib/allowlist';
import { env } from '@/lib/env';
import type { Family } from '@/lib/families';

describe('isAllowedEmail', () => {
  const original = env.FAMILIES;
  const setFamilies = (families: Family[]) => {
    (env as { FAMILIES: Family[] }).FAMILIES = families;
  };
  afterEach(() => {
    (env as { FAMILIES: Family[] }).FAMILIES = original;
  });

  it('matches case-insensitively for the right role', () => {
    setFamilies([{ child: 'kid@example.com', parents: ['mum@example.com'] }]);
    expect(isAllowedEmail('student', 'KID@example.com')).toBe(true);
    expect(isAllowedEmail('parent', '  mum@example.com ')).toBe(true);
  });

  it('does not let a role use the other role’s list', () => {
    setFamilies([{ child: 'kid@example.com', parents: ['mum@example.com'] }]);
    expect(isAllowedEmail('parent', 'kid@example.com')).toBe(false);
    expect(isAllowedEmail('student', 'mum@example.com')).toBe(false);
  });

  it('allows a standalone child but no parent for that family', () => {
    setFamilies([{ child: 'kid@example.com', parents: [] }]);
    expect(isAllowedEmail('student', 'kid@example.com')).toBe(true);
    expect(isAllowedEmail('parent', 'kid@example.com')).toBe(false);
  });

  it('fails closed on an empty config or empty email', () => {
    setFamilies([]);
    expect(isAllowedEmail('student', 'kid@example.com')).toBe(false);
    expect(isAllowedEmail('parent', 'mum@example.com')).toBe(false);
    setFamilies([{ child: 'kid@example.com', parents: ['mum@example.com'] }]);
    expect(isAllowedEmail('student', '')).toBe(false);
    expect(isAllowedEmail('parent', '   ')).toBe(false);
  });
});
