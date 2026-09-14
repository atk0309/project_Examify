import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  passwordMeetsPolicy,
  verifyPassword,
  verifyPasswordOrDummy,
} from '@/lib/password';

describe('password hashing', () => {
  it('accepts a policy-compliant password and rejects short ones', () => {
    expect(passwordMeetsPolicy('long-enough')).toBe(true);
    expect(passwordMeetsPolicy('short')).toBe(false);
  });

  it('round-trips a hash', () => {
    const stored = hashPassword('correct-horse');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct-horse', stored)).toBe(true);
    expect(verifyPassword('wrong-password', stored)).toBe(false);
  });

  it('treats a missing hash as a failed verify after dummy work', () => {
    expect(verifyPasswordOrDummy('correct-horse', null)).toBe(false);
    expect(verifyPasswordOrDummy('correct-horse', undefined)).toBe(false);
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});
