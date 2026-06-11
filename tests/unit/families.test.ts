import { describe, expect, it } from 'vitest';
import {
  childEmailsForParent,
  parentEmails,
  parseFamilies,
  studentEmails,
  type Family,
} from '@/lib/families';

/** Shorthand: parse and assert success, returning the families. */
function parse(raw: string): Family[] {
  const result = parseFamilies(raw);
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.families;
}

describe('parseFamilies', () => {
  it('parses a valid config', () => {
    const families = parse(
      '[{"child":"kid@example.com","parents":["mum@example.com","dad@example.com"]}]',
    );
    expect(families).toEqual([
      { child: 'kid@example.com', parents: ['mum@example.com', 'dad@example.com'] },
    ]);
  });

  it('defaults missing parents to []', () => {
    expect(parse('[{"child":"kid@example.com"}]')).toEqual([
      { child: 'kid@example.com', parents: [] },
    ]);
  });

  it('accepts a standalone child with parents: []', () => {
    expect(parse('[{"child":"kid@example.com","parents":[]}]')).toEqual([
      { child: 'kid@example.com', parents: [] },
    ]);
  });

  it('treats empty input as an empty config', () => {
    expect(parseFamilies('')).toEqual({ ok: true, families: [] });
  });

  it('treats whitespace-only input as an empty config', () => {
    expect(parseFamilies('   \n  ')).toEqual({ ok: true, families: [] });
  });

  it('rejects malformed JSON', () => {
    const result = parseFamilies('[{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/json/i);
  });

  it('rejects an invalid child email', () => {
    expect(parseFamilies('[{"child":"not-an-email","parents":[]}]').ok).toBe(false);
  });

  it('rejects an invalid parent email', () => {
    expect(parseFamilies('[{"child":"kid@example.com","parents":["nope"]}]').ok).toBe(false);
  });

  it('lowercases and trims all emails', () => {
    expect(parse('[{"child":"  KID@Example.com ","parents":[" MUM@EXAMPLE.com "]}]')).toEqual([
      { child: 'kid@example.com', parents: ['mum@example.com'] },
    ]);
  });

  it('de-dupes a parent repeated within a family', () => {
    expect(
      parse('[{"child":"kid@example.com","parents":["mum@example.com","MUM@example.com"]}]'),
    ).toEqual([{ child: 'kid@example.com', parents: ['mum@example.com'] }]);
  });

  it('rejects the same child email across families', () => {
    const result = parseFamilies(
      '[{"child":"kid@example.com","parents":[]},{"child":"KID@example.com","parents":[]}]',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/duplicate child/i);
  });

  it('rejects an email used as both a child and a parent', () => {
    const result = parseFamilies(
      '[{"child":"kid@example.com","parents":[]},{"child":"sam@example.com","parents":["kid@example.com"]}]',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/both a child and a parent/i);
  });

  it('rejects the same parent appearing in more than one family', () => {
    const result = parseFamilies(
      '[{"child":"a@example.com","parents":["mum@example.com"]},{"child":"b@example.com","parents":["mum@example.com"]}]',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/more than one family/i);
  });
});

describe('studentEmails / parentEmails', () => {
  const families: Family[] = [
    { child: 'a@example.com', parents: ['mum@example.com', 'dad@example.com'] },
    { child: 'b@example.com', parents: ['other@example.com'] },
    { child: 'c@example.com', parents: [] },
  ];

  it('studentEmails lists every child', () => {
    expect(studentEmails(families)).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
  });

  it('parentEmails lists every parent across families', () => {
    expect(parentEmails(families)).toEqual([
      'mum@example.com',
      'dad@example.com',
      'other@example.com',
    ]);
  });
});

describe('childEmailsForParent', () => {
  const families: Family[] = [
    { child: 'alex@example.com', parents: ['mum@example.com', 'dad@example.com'] },
    { child: 'sam@example.com', parents: ['sam.parent@example.com'] },
    { child: 'jess@example.com', parents: [] },
  ];

  it('isolates families — a parent only gets their own child', () => {
    expect(childEmailsForParent(families, 'mum@example.com')).toEqual(['alex@example.com']);
    expect(childEmailsForParent(families, 'sam.parent@example.com')).toEqual(['sam@example.com']);
  });

  it('both parents in a pair resolve the same child', () => {
    expect(childEmailsForParent(families, 'dad@example.com')).toEqual(['alex@example.com']);
    expect(childEmailsForParent(families, 'mum@example.com')).toEqual(['alex@example.com']);
  });

  it('matches case-insensitively and trims', () => {
    expect(childEmailsForParent(families, '  MUM@Example.com ')).toEqual(['alex@example.com']);
  });

  it('an unrelated parent resolves no children', () => {
    expect(childEmailsForParent(families, 'stranger@example.com')).toEqual([]);
  });

  it('a standalone child belongs to no parent', () => {
    // jess has no parents, so no email ever maps to her.
    expect(childEmailsForParent(families, 'jess@example.com')).toEqual([]);
    expect(families.some((f) => f.parents.length > 0 && f.child === 'jess@example.com')).toBe(
      false,
    );
  });
});
