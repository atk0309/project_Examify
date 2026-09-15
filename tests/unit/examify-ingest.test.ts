import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_IDS,
  parseArgs,
  planEmit,
  runCli,
  splitIr,
  validateIrCollection,
  type BankIR,
} from '../../tools/examify-ingest/src/index';
import { SAMPLE_FIXTURE_IDS } from '@/lib/exam/fixture-ids';

const repoRoot = path.resolve(__dirname, '../..');

function loadBiologyIr(): BankIR {
  return JSON.parse(
    readFileSync(path.join(repoRoot, 'content/subjects/biology/bank.ir.json'), 'utf8'),
  ) as BankIR;
}

function collidingFixtureIr(): BankIR {
  return {
    version: 1,
    subject: { id: 'maths', label: 'Maths', icon: 'maths', l: 0.5, c: 0.05, h: 150 },
    difficulties: {
      easy: [
        {
          id: 'maths-easy-1',
          type: 'mcq',
          q: 'Replaced fixture question?',
          choices: ['A', 'B', 'C', 'D'],
          answer: 0,
          provenance: { pdf: 'hand-authored', locator: 'collision' },
        },
      ],
      medium: [],
      hard: [],
    },
  };
}

describe('examify-ingest schema + split', () => {
  it('keeps FIXTURE_IDS in lockstep with the app', () => {
    expect([...FIXTURE_IDS]).toEqual([...SAMPLE_FIXTURE_IDS]);
  });

  it('validates the sample biology IR', () => {
    const result = validateIrCollection([{ path: 'biology/bank.ir.json', data: loadBiologyIr() }]);
    expect(result.ok, result.ok ? '' : result.errors.map((e) => e.message).join('\n')).toBe(true);
  });

  it('splitIr strips answer/rubric/maxScore/provenance from public questions', () => {
    const split = splitIr(loadBiologyIr());
    const publicJson = JSON.stringify(split.questions);
    expect(publicJson).not.toContain('"answer"');
    expect(publicJson).not.toContain('"rubric"');
    expect(publicJson).not.toContain('"maxScore"');
    expect(publicJson).not.toContain('"provenance"');
    expect(split.questions.easy).toHaveLength(2);
    expect(split.keys['biology-easy-1']).toMatchObject({ type: 'mcq', answer: 2 });
    expect(split.keys['biology-easy-free-1']).toMatchObject({ type: 'free', maxScore: 2 });
    expect(Object.keys(split.questions.easy![0]!).sort()).toEqual(['choices', 'id', 'q', 'type']);
    expect(Object.keys(split.questions.easy![1]!).sort()).toEqual(['id', 'q', 'type']);
  });

  it('refuses frozen fixture ids unless --replace-sample', () => {
    const files = [{ path: 'maths/bank.ir.json', data: collidingFixtureIr() }];
    const blocked = validateIrCollection(files);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.errors.some((error) => error.message.includes('maths-easy-1'))).toBe(true);
      expect(blocked.errors.some((error) => error.message.includes('--replace-sample'))).toBe(true);
    }

    const allowed = validateIrCollection(files, { replaceSample: true });
    expect(allowed.ok, allowed.ok ? '' : allowed.errors.map((e) => e.message).join('\n')).toBe(
      true,
    );
  });

  it('rejects ids that do not follow the subject-difficulty convention', () => {
    const ir = loadBiologyIr();
    ir.difficulties.easy[0]!.id = 'plants-easy-1';
    const result = validateIrCollection([{ path: 'biology/bank.ir.json', data: ir }]);
    expect(result.ok).toBe(false);
  });
});

describe('examify-ingest emit plan', () => {
  it('plans the three generated targets and keeps secrets in keys only', () => {
    const validated = validateIrCollection([
      { path: 'biology/bank.ir.json', data: loadBiologyIr() },
    ]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-ingest-'));
    const planned = planEmit(validated.banks, tmp);
    expect(planned.map((file) => file.relPath)).toEqual([
      'content/generated/subjects.json',
      'content/generated/questions/biology.json',
      'content/generated/keys/biology.json',
    ]);
    expect(planned.every((file) => file.existing === null)).toBe(true);

    const questions = planned.find((file) => file.relPath.endsWith('questions/biology.json'))!;
    expect(questions.contents).not.toContain('"answer"');
    expect(questions.contents).not.toContain('"rubric"');
    expect(questions.contents).not.toContain('"maxScore"');
    expect(questions.contents).not.toContain('"provenance"');

    const keys = planned.find((file) => file.relPath.endsWith('keys/biology.json'))!;
    expect(keys.contents).toContain('"answer"');
    expect(keys.contents).toContain('"rubric"');
    expect(keys.contents).toContain('"provenance"');
  });
});

describe('examify-ingest CLI', () => {
  it('parses emit as dry-run unless --apply', () => {
    const dry = parseArgs(['emit', 'content/subjects']);
    expect('error' in dry).toBe(false);
    if ('error' in dry) return;
    expect(dry.apply).toBe(false);
    expect(dry.dryRun).toBe(true);

    const apply = parseArgs(['emit', 'content/subjects', '--apply']);
    expect('error' in apply).toBe(false);
    if ('error' in apply) return;
    expect(apply.apply).toBe(true);
  });

  it('validate succeeds on content/subjects', () => {
    const chunks: string[] = [];
    const code = runCli(['validate', 'content/subjects'], {
      cwd: repoRoot,
      stdout: { write: (chunk) => void chunks.push(chunk) },
      stderr: { write: (chunk) => void chunks.push(chunk) },
    });
    expect(code).toBe(0);
    expect(chunks.join('')).toContain('ok 1 BankIR file');
  });

  it('emit --dry-run prints would create / planned files', () => {
    const chunks: string[] = [];
    const code = runCli(['emit', 'content/subjects', '--dry-run'], {
      cwd: repoRoot,
      stdout: { write: (chunk) => void chunks.push(chunk) },
      stderr: { write: (chunk) => void chunks.push(chunk) },
    });
    expect(code).toBe(0);
    const out = chunks.join('');
    expect(out).toMatch(
      /unchanged content\/generated\/subjects.json|would update content\/generated\/subjects.json/,
    );
    expect(out).toContain('content/generated/questions/biology.json');
    expect(out).toContain('content/generated/keys/biology.json');
    expect(out).toContain('(dry-run; pass --apply to write)');
  });

  it('CLI validate refuses a fixture collision without --replace-sample', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-ir-'));
    const irPath = path.join(tmp, 'bank.ir.json');
    writeFileSync(irPath, JSON.stringify(collidingFixtureIr()), 'utf8');
    const stderr: string[] = [];
    const code = runCli(['validate', irPath], {
      cwd: repoRoot,
      stdout: { write: () => undefined },
      stderr: { write: (chunk) => void stderr.push(chunk) },
    });
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('--replace-sample');
  });
});
