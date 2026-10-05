import { describe, expect, it } from 'vitest';
import { parseFamilies, type Family } from '@/lib/families';

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
