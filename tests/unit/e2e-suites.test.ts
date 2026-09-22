import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FRESH_SPEC, PASSWORD_SPEC } from '../e2e/suites';

const E2E_DIR = path.join(process.cwd(), 'tests', 'e2e');

type Suite = 'seeded' | 'fresh' | 'password';

/** Mirrors the testMatch / testIgnore split across the three Playwright configs. */
function suitesFor(file: string): Suite[] {
  const suites: Suite[] = [];
  if (!FRESH_SPEC.test(file) && !PASSWORD_SPEC.test(file)) suites.push('seeded');
  if (FRESH_SPEC.test(file)) suites.push('fresh');
  if (PASSWORD_SPEC.test(file)) suites.push('password');
  return suites;
}

describe('Playwright suite split', () => {
  it('runs every e2e spec under exactly one config', () => {
    const specs = fs.readdirSync(E2E_DIR).filter((name) => /\.(spec|test)\.ts$/.test(name));
    expect(specs.length).toBeGreaterThan(0);
    for (const name of specs) {
      expect(suitesFor(path.join(E2E_DIR, name)), name).toHaveLength(1);
    }
  });

  it('sends password.spec.ts only to the password config', () => {
    expect(suitesFor(path.join(E2E_DIR, 'password.spec.ts'))).toEqual(['password']);
    expect(suitesFor(path.join(E2E_DIR, 'fresh.spec.ts'))).toEqual(['fresh']);
    expect(suitesFor(path.join(E2E_DIR, 'signin.spec.ts'))).toEqual(['seeded']);
  });

  it('does not treat a spec that merely ends in "password" as the password suite', () => {
    expect(suitesFor(path.join(E2E_DIR, 'forgot-password.spec.ts'))).toEqual(['seeded']);
    expect(suitesFor('C:\\repo\\tests\\e2e\\password.spec.ts')).toEqual(['password']);
  });
});
