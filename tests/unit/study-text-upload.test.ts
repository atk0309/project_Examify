import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import {
  addOnboardingSubject,
  attachSourcePdf,
  detachSourcePdf,
  isUtf8StudyText,
  listOnboardingSubjects,
  MAX_SOURCE_TEXT_BYTES,
  sanitizeUploadName,
  setOnboardingContentRootForTests,
} from '@/lib/onboarding';

let root: string;
const previousMode = env.EXAMIFY_MODE;
beforeEach(() => {
  env.EXAMIFY_MODE = 'solo';
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-study-text-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  setOnboardingContentRootForTests(root);
  expect(addOnboardingSubject({ id: 'history', label: 'History', icon: 'geography' }).ok).toBe(
    true,
  );
});
afterEach(() => {
  env.EXAMIFY_MODE = previousMode;
  setOnboardingContentRootForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});
function upload(
  filename: string,
  bytes = Buffer.from('Useful UTF-8 study notes: café\n'),
  allowText = true,
) {
  return attachSourcePdf({ subjectId: 'history', filename, bytes }, root, { allowText });
}
describe('bounded UTF-8 study-note uploads', () => {
  it('sanitizes notes with the existing safe basename rules', () => {
    expect(sanitizeUploadName('Mum’s notes, été.MD', true)).toEqual({
      ok: true,
      filename: 'Mums notes ete.md',
    });
    expect(sanitizeUploadName('../outside.txt', true)).toEqual({
      ok: false,
      reason: 'invalid_name',
    });
    expect(sanitizeUploadName('run.js', true)).toEqual({ ok: false, reason: 'invalid_type' });
  });
  it('keeps household/default helper uploads PDF-only', () => {
    expect(upload('notes.txt', undefined, false)).toEqual({ ok: false, reason: 'invalid_type' });
    expect(upload('notes.pdf', Buffer.from('%PDF-1.4 fixture'), false).ok).toBe(true);
    expect(sanitizeUploadName('notes.md').ok).toBe(false);
  });
  it.each(['notes.txt', 'notes.md'])(
    'stores and lists %s as a real generate source, then detaches it',
    (filename) => {
      expect(upload(filename)).toEqual({ ok: true, filename });
      const subject = listOnboardingSubjects()[0]!;
      expect(subject.sourceFiles).toContain(filename);
      expect(subject.generateSources).toContain(`content/source-pdfs/history/${filename}`);
      expect(detachSourcePdf({ subjectId: 'history', filename }, root)).toEqual({
        ok: false,
        reason: 'invalid_id',
      });
      expect(
        detachSourcePdf({ subjectId: 'history', filename }, root, { allowText: true }),
      ).toEqual({ ok: true });
      expect(listOnboardingSubjects()[0]!.sourceFiles).toEqual([]);
    },
  );
  it('rejects empty, binary, NUL/control-containing and malformed UTF-8 notes without writing', () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from(' \r\n'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('a\0b'),
      Buffer.from('a\x1bb'),
    ]) {
      expect(isUtf8StudyText(bytes)).toBe(false);
      expect(upload('bad.txt', bytes)).toEqual({ ok: false, reason: 'invalid_type' });
    }
    expect(listOnboardingSubjects()[0]!.sourceFiles).toEqual([]);
  });
  it('enforces the 1 MiB note cap while preserving the independent PDF limit/magic', () => {
    expect(upload('large.md', Buffer.alloc(MAX_SOURCE_TEXT_BYTES + 1, 'a'))).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(upload('fake.pdf', Buffer.from('not a PDF'))).toEqual({
      ok: false,
      reason: 'invalid_type',
    });
    expect(upload('max.txt', Buffer.alloc(MAX_SOURCE_TEXT_BYTES, 'a')).ok).toBe(true);
  });
  it('deduplicates identical uploads and preserves different same-name contents', () => {
    expect(upload('notes.md', Buffer.from('first'))).toEqual({ ok: true, filename: 'notes.md' });
    expect(upload('notes.md', Buffer.from('first'))).toEqual({ ok: true, filename: 'notes.md' });
    expect(upload('notes.md', Buffer.from('second'))).toEqual({
      ok: true,
      filename: 'notes (2).md',
    });
    expect(fs.readFileSync(path.join(root, 'content/source-pdfs/history/notes.md'), 'utf8')).toBe(
      'first',
    );
  });
  it('never follows an existing note symlink or deletes its target', () => {
    const directory = path.join(root, 'content/source-pdfs/history');
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(root, 'valuable.txt');
    fs.writeFileSync(target, 'preserve');
    fs.symlinkSync(target, path.join(directory, 'notes.txt'));
    expect(upload('notes.txt')).toEqual({ ok: true, filename: 'notes (2).txt' });
    expect(
      detachSourcePdf({ subjectId: 'history', filename: 'notes.txt' }, root, { allowText: true }),
    ).toEqual({ ok: false, reason: 'unsafe_path' });
    expect(fs.readFileSync(target, 'utf8')).toBe('preserve');
  });
});
