import { describe, expect, it } from 'vitest';
import {
  isPasswordAuth,
  parseAuthMode,
  parseMailTransport,
  resolveAuthMode,
  usesEmailChallenge,
  usesLocalOtp,
  usesMagicLink,
} from '@/lib/auth-mode';

describe('auth-mode helpers', () => {
  it('parses known modes and defaults unknown values to magic-link', () => {
    expect(parseAuthMode('password')).toBe('password');
    expect(parseAuthMode('magic-link')).toBe('magic-link');
    expect(parseAuthMode('local-otp')).toBe('local-otp');
    expect(parseAuthMode('passkeys')).toBeUndefined();
    expect(resolveAuthMode(undefined)).toBe('magic-link');
    expect(resolveAuthMode('nope')).toBe('magic-link');
  });

  it('classifies modes', () => {
    expect(isPasswordAuth('password')).toBe(true);
    expect(usesMagicLink('magic-link')).toBe(true);
    expect(usesLocalOtp('local-otp')).toBe(true);
    expect(usesEmailChallenge('magic-link')).toBe(true);
    expect(usesEmailChallenge('local-otp')).toBe(true);
    expect(usesEmailChallenge('password')).toBe(false);
  });

  it('parses mail transports', () => {
    expect(parseMailTransport('auto')).toBe('auto');
    expect(parseMailTransport('smtp')).toBe('smtp');
    expect(parseMailTransport('resend')).toBe('resend');
    expect(parseMailTransport('outbox')).toBe('outbox');
    expect(parseMailTransport('sendgrid')).toBeUndefined();
  });
});
