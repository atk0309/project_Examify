import { describe, expect, it } from 'vitest';
import { isOtpShapedBearer, isResetShapedBearer, usesMagicLink } from '@/lib/auth-mode';

describe('auth-mode helpers', () => {
  it('recognizes only magic-link mode', () => {
    expect(usesMagicLink('magic-link')).toBe(true);
    expect(usesMagicLink('password')).toBe(false);
    expect(usesMagicLink('local-otp')).toBe(false);
  });

  it('detects local-OTP bearers', () => {
    expect(isOtpShapedBearer('otp:kid@example.com:student:000000')).toBe(true);
    expect(isOtpShapedBearer('  otp:x')).toBe(true);
    expect(isOtpShapedBearer('good-magic-token')).toBe(false);
    expect(isOtpShapedBearer('')).toBe(false);
    expect(isResetShapedBearer('reset:ada@example.com:parent:000000')).toBe(true);
    expect(isResetShapedBearer('otp:ada@example.com:parent:000000')).toBe(false);
  });
});
