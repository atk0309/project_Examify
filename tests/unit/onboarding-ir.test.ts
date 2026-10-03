import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadOnboardingIrFiles,
  MAX_ONBOARDING_IR_DIRECTORY_ENTRIES,
  MAX_ONBOARDING_IR_FILE_BYTES,
  MAX_ONBOARDING_IR_TOTAL_BYTES,
} from '@/lib/onboarding-ir.server';

let temporary: string;
let root: string;

beforeEach(() => {
  temporary = mkdtempSync(path.join(tmpdir(), 'examify-onboarding-ir-'));
  root = path.join(temporary, 'family');
  mkdirSync(root);
});

afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
});

function draftPath(id = 'alpha'): string {
  return path.join(root, 'content', 'subjects', id, 'bank.ir.json');
}

function writeDraft(id: string, raw: string): string {
  const file = draftPath(id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, raw);
  return file;
}

function jsonBytes(bytes: number): string {
  return `"${'x'.repeat(bytes - 2)}"`;
}

function safeFailure(run: () => unknown): string {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  const error = failure as Error;
  expect(error.message).not.toContain(temporary);
  expect(error.message).not.toContain('SECRET');
  expect(error.cause).toBeUndefined();
  return error.message;
}

describe('bounded web onboarding draft reader', () => {
  it('returns an empty collection for an absent content tree, subjects tree, or drafts', () => {
    expect(loadOnboardingIrFiles(root)).toEqual([]);
    mkdirSync(path.join(root, 'content'));
    expect(loadOnboardingIrFiles(root)).toEqual([]);
    mkdirSync(path.join(root, 'content', 'subjects'));
    expect(loadOnboardingIrFiles(root)).toEqual([]);
    mkdirSync(path.dirname(draftPath()));
    writeFileSync(path.join(path.dirname(draftPath()), 'subject.json'), '{}');
    expect(loadOnboardingIrFiles(root)).toEqual([]);
  });

  it('loads JSON unchanged in path order without following deeper or direct-root drafts', () => {
    const beta = {
      version: 1,
      subject: { id: 'beta', label: 'β biology' },
      difficulties: {
        easy: [
          {
            id: 'beta-1',
            q: 'A question?',
            choices: ['first', 'second'],
            answer: 1,
            provenance: { pdf: 'notes.pdf', locator: 'page 3' },
          },
        ],
        medium: [],
        hard: [],
      },
    };
    const betaPath = writeDraft('beta', JSON.stringify(beta));
    const alpha = [null, false, 7, 'unchanged', { nested: [1, 2, 3] }];
    const alphaPath = writeDraft('alpha', JSON.stringify(alpha));
    writeFileSync(path.join(root, 'content', 'subjects', 'bank.ir.json'), '{invalid');
    mkdirSync(path.join(root, 'content', 'subjects', 'nested', 'deeper'), { recursive: true });
    writeFileSync(
      path.join(root, 'content', 'subjects', 'nested', 'deeper', 'bank.ir.json'),
      '{invalid',
    );
    expect(loadOnboardingIrFiles(root)).toEqual([
      { path: alphaPath, data: alpha },
      { path: betaPath, data: beta },
    ]);
  });

  it.each(['content', 'content/subjects', 'content/subjects/alpha'])(
    'rejects an outside-directory link at %s without reading outside drafts',
    (relative) => {
      const outside = path.join(temporary, 'outside-SECRET');
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'bank.ir.json'), 'SECRET invalid external JSON');
      const link = path.join(root, relative);
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(outside, link, 'dir');
      expect(safeFailure(() => loadOnboardingIrFiles(root))).toBe(
        'Question drafts must be regular files in real folders inside the family data folder.',
      );
      expect(readFileSync(path.join(outside, 'bank.ir.json'), 'utf8')).toBe(
        'SECRET invalid external JSON',
      );
    },
  );

  it('rejects a symlinked bank even when its destination is a regular file inside the root', () => {
    const target = path.join(root, 'actual.json');
    writeFileSync(target, '{}');
    mkdirSync(path.dirname(draftPath()), { recursive: true });
    symlinkSync(target, draftPath());
    expect(safeFailure(() => loadOnboardingIrFiles(root))).toContain('regular files');
  });

  it('rejects an outside bank-file symlink without including its path or contents', () => {
    const outside = path.join(temporary, 'SECRET-bank.json');
    writeFileSync(outside, '{ SECRET answer: 3 }');
    mkdirSync(path.dirname(draftPath()), { recursive: true });
    symlinkSync(outside, draftPath());
    expect(safeFailure(() => loadOnboardingIrFiles(root))).toContain('regular files');
  });

  it.each([
    'content',
    'content/subjects',
    'content/subjects/alpha',
    'content/subjects/alpha/bank.ir.json',
  ])('rejects a dangling link at %s rather than treating it as an absent draft', (relative) => {
    const link = path.join(root, relative);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(path.join(temporary, 'missing-SECRET'), link);
    expect(safeFailure(() => loadOnboardingIrFiles(root))).toContain('regular files');
  });

  it('rejects even a linked child entry that is not a subject directory', () => {
    const ordinary = path.join(root, 'ordinary.json');
    writeFileSync(ordinary, '{}');
    mkdirSync(path.join(root, 'content', 'subjects'), { recursive: true });
    symlinkSync(ordinary, path.join(root, 'content', 'subjects', 'linked-file'));
    expect(safeFailure(() => loadOnboardingIrFiles(root))).toContain('regular files');
  });

  it('rejects a bank path that is a directory', () => {
    mkdirSync(draftPath(), { recursive: true });
    expect(safeFailure(() => loadOnboardingIrFiles(root))).toContain('regular files');
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO bank without blocking on a read', () => {
    mkdirSync(path.dirname(draftPath()), { recursive: true });
    execFileSync('mkfifo', [draftPath()]);
    expect(safeFailure(() => loadOnboardingIrFiles(root))).toContain('regular files');
  });

  it.each(['content', 'content/subjects'])('rejects a non-directory %s component', (relative) => {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'SECRET');
    expect(safeFailure(() => loadOnboardingIrFiles(root))).toContain('regular files');
  });

  it('rejects oversized individual drafts without returning a partial collection', () => {
    writeDraft('alpha', '{}');
    writeDraft('beta', jsonBytes(MAX_ONBOARDING_IR_FILE_BYTES + 1));
    expect(safeFailure(() => loadOnboardingIrFiles(root))).toBe(
      'A question draft exceeds the 2 MiB web review limit.',
    );
  });

  it('measures per-file limits in UTF-8 bytes, not string characters', () => {
    const raw = JSON.stringify('é'.repeat(MAX_ONBOARDING_IR_FILE_BYTES / 2));
    expect(raw.length).toBeLessThan(MAX_ONBOARDING_IR_FILE_BYTES);
    writeDraft('alpha', raw);
    expect(safeFailure(() => loadOnboardingIrFiles(root))).toContain('2 MiB');
  });

  it('allows the exact per-file and aggregate limits with no truncation', () => {
    const raw = jsonBytes(MAX_ONBOARDING_IR_FILE_BYTES);
    const expected = JSON.parse(raw);
    for (let index = 0; index < 4; index += 1) writeDraft(`subject-${index}`, raw);
    expect(MAX_ONBOARDING_IR_FILE_BYTES * 4).toBe(MAX_ONBOARDING_IR_TOTAL_BYTES);
    const loaded = loadOnboardingIrFiles(root);
    expect(loaded).toHaveLength(4);
    for (const file of loaded) expect(file.data).toBe(expected);
  });

  it('rejects cumulative bytes above the aggregate limit even when every file fits', () => {
    for (let index = 0; index < 4; index += 1) {
      writeDraft(`subject-${index}`, jsonBytes(MAX_ONBOARDING_IR_FILE_BYTES));
    }
    writeDraft('subject-4', '{}');
    expect(safeFailure(() => loadOnboardingIrFiles(root))).toBe(
      'Question drafts exceed the 8 MiB web review limit.',
    );
  });

  it('bounds all immediate directory entries, including files that are otherwise ignored', () => {
    const subjects = path.join(root, 'content', 'subjects');
    mkdirSync(subjects, { recursive: true });
    for (let index = 0; index < MAX_ONBOARDING_IR_DIRECTORY_ENTRIES; index += 1) {
      writeFileSync(path.join(subjects, `note-${index}`), '');
    }
    expect(loadOnboardingIrFiles(root)).toEqual([]);
    writeFileSync(path.join(subjects, 'one-too-many'), '');
    expect(safeFailure(() => loadOnboardingIrFiles(root))).toBe(
      'The subjects folder contains too many entries for web review.',
    );
  });

  it.each(['{ "SECRET-answer": ', 'SECRET-private-answer: 3', ''])(
    'replaces JSON parser details with a constant safe message (%#)',
    (raw) => {
      writeDraft('SECRET-subject', raw);
      expect(safeFailure(() => loadOnboardingIrFiles(root))).toBe(
        'A question draft contains invalid JSON. Check the draft and try again.',
      );
    },
  );

  it('replaces unexpected filesystem errors with a safe constant message', () => {
    expect(safeFailure(() => loadOnboardingIrFiles(path.join(root, 'SECRET-missing-root')))).toBe(
      'Question drafts could not be read safely. Check the subject files and try again.',
    );
  });
});
