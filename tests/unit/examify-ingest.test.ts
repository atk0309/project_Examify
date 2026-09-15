import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLE_QUESTIONS } from '@/lib/exam/data';
import { SAMPLE_FIXTURE_IDS } from '@/lib/exam/fixture-ids';
import {
  applyEmit,
  collectGeneratedSubjectIds,
  collectQuestionIds,
  FIXTURE_IDS,
  formatFileDiff,
  isAuthoritativeCatalogInput,
  parseArgs,
  planEmit,
  readGeneratedSubjects,
  resolveIrFiles,
  runCli,
  USAGE,
  splitIr,
  validateIrCollection,
  type BankIR,
} from '../../tools/examify-ingest/src/index';
import { MAX_DIFF_CELLS } from '../../tools/examify-ingest/src/diff';
import { renderGeneratedPublic } from '../../tools/examify-ingest/src/registrars';

const repoRoot = path.resolve(__dirname, '../..');
const SAMPLE_IDS = collectQuestionIds(SAMPLE_QUESTIONS);

function loadBiologyIr(): BankIR {
  return JSON.parse(
    readFileSync(path.join(repoRoot, 'content/subjects/biology/bank.ir.json'), 'utf8'),
  ) as BankIR;
}

const leftoverChemistrySubject = {
  id: 'chemistry',
  label: 'Chemistry',
  icon: 'chemistry',
  l: 0.55,
  c: 0.1,
  h: 40,
};

function writeLeftoverChemistry(generatedDir: string): {
  questionsPath: string;
  keysPath: string;
  questionsBefore: string;
  keysBefore: string;
} {
  mkdirSync(path.join(generatedDir, 'questions'), { recursive: true });
  mkdirSync(path.join(generatedDir, 'keys'), { recursive: true });
  const chemistryQuestions = {
    easy: [
      {
        id: 'chemistry-easy-1',
        type: 'mcq',
        q: 'Keep this chemistry question',
        choices: ['A', 'B', 'C', 'D'],
      },
    ],
    medium: [],
    hard: [],
  };
  const chemistryKeys = {
    'chemistry-easy-1': {
      type: 'mcq',
      answer: 1,
      provenance: { pdf: 'hand-authored', locator: 'keep-me' },
    },
  };
  const questionsPath = path.join(generatedDir, 'questions/chemistry.json');
  const keysPath = path.join(generatedDir, 'keys/chemistry.json');
  const questionsBefore = `${JSON.stringify(chemistryQuestions, null, 2)}\n`;
  const keysBefore = `${JSON.stringify(chemistryKeys, null, 2)}\n`;
  writeFileSync(
    path.join(generatedDir, 'subjects.json'),
    `${JSON.stringify([leftoverChemistrySubject], null, 2)}\n`,
  );
  writeFileSync(questionsPath, questionsBefore);
  writeFileSync(keysPath, keysBefore);
  return { questionsPath, keysPath, questionsBefore, keysBefore };
}

function collidingSampleIr(id: 'maths-easy-1' | 'maths-easy-2'): BankIR {
  return {
    version: 1,
    subject: { id: 'maths', label: 'Maths', icon: 'maths', l: 0.5, c: 0.05, h: 150 },
    difficulties: {
      easy: [
        {
          id,
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
  it('freezes every sample-bank id, including the test-coupled fixtures', () => {
    expect([...FIXTURE_IDS]).toEqual([...SAMPLE_FIXTURE_IDS]);
    expect(SAMPLE_IDS.length).toBeGreaterThan(FIXTURE_IDS.length);
    for (const id of FIXTURE_IDS) expect(SAMPLE_IDS).toContain(id);
    expect(SAMPLE_IDS).toContain('maths-easy-2');
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

  it('refuses any sample-bank id unless --replace-sample', () => {
    for (const id of ['maths-easy-1', 'maths-easy-2'] as const) {
      const files = [{ path: 'maths/bank.ir.json', data: collidingSampleIr(id) }];
      const blocked = validateIrCollection(files, { frozenIds: SAMPLE_IDS });
      expect(blocked.ok, `${id} should be frozen`).toBe(false);
      if (!blocked.ok) {
        expect(blocked.errors.some((error) => error.message.includes(id))).toBe(true);
        expect(blocked.errors.some((error) => error.message.includes('--replace-sample'))).toBe(
          true,
        );
      }

      const allowed = validateIrCollection(files, { frozenIds: SAMPLE_IDS, replaceSample: true });
      expect(
        allowed.ok,
        allowed.ok ? '' : allowed.errors.map((error) => error.message).join('\n'),
      ).toBe(true);
    }
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

  it('partial emit upserts subjects.json and leaves other subject files alone', () => {
    const validated = validateIrCollection([
      { path: 'biology/bank.ir.json', data: loadBiologyIr() },
    ]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-partial-'));
    const generated = path.join(tmp, 'content/generated');
    const { questionsPath, keysPath, questionsBefore, keysBefore } =
      writeLeftoverChemistry(generated);

    const planned = planEmit(validated.banks, tmp);
    expect(planned.map((file) => file.relPath)).toEqual([
      'content/generated/subjects.json',
      'content/generated/questions/biology.json',
      'content/generated/keys/biology.json',
    ]);
    expect(planned.some((file) => file.delete)).toBe(false);
    expect(JSON.parse(planned[0]!.contents).map((subject: { id: string }) => subject.id)).toEqual([
      'chemistry',
      'biology',
    ]);

    applyEmit(planned);
    expect(readFileSync(questionsPath, 'utf8')).toBe(questionsBefore);
    expect(readFileSync(keysPath, 'utf8')).toBe(keysBefore);
    expect(
      JSON.parse(readFileSync(path.join(generated, 'subjects.json'), 'utf8')).map(
        (s: { id: string }) => s.id,
      ),
    ).toEqual(['chemistry', 'biology']);
    expect(readFileSync(path.join(generated, 'questions/biology.json'), 'utf8')).toContain(
      'biology-easy-1',
    );
  });

  it('whole-tree emit drops leftover generated JSON when the IR subject is gone', () => {
    const validated = validateIrCollection([
      { path: 'biology/bank.ir.json', data: loadBiologyIr() },
    ]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-prune-'));
    const generated = path.join(tmp, 'content/generated');
    const leftover = writeLeftoverChemistry(generated);
    mkdirSync(path.join(tmp, 'src/lib/exam'), { recursive: true });
    writeFileSync(path.join(tmp, 'src/lib/exam/generated-public.ts'), 'export {}\n');
    writeFileSync(path.join(tmp, 'src/lib/exam/generated-keys.server.ts'), 'export {}\n');

    expect([...collectGeneratedSubjectIds(tmp)].sort()).toEqual(['chemistry']);

    const planned = planEmit(validated.banks, tmp, { pruneMissing: true });
    expect(
      planned
        .filter((file) => file.delete)
        .map((file) => file.relPath)
        .sort(),
    ).toEqual([
      'content/generated/keys/chemistry.json',
      'content/generated/questions/chemistry.json',
    ]);
    expect(JSON.parse(planned[0]!.contents).map((subject: { id: string }) => subject.id)).toEqual([
      'biology',
    ]);
    const publicRegistrar = planned.find((file) => file.relPath.endsWith('generated-public.ts'));
    const keysRegistrar = planned.find((file) => file.relPath.endsWith('generated-keys.server.ts'));
    expect(publicRegistrar?.contents).toContain('biology');
    expect(publicRegistrar?.contents).not.toContain('chemistry');
    expect(keysRegistrar?.contents).toContain('biology');
    expect(keysRegistrar?.contents).not.toContain('chemistry');
    expect(
      planned.every(
        (file) =>
          !file.relPath.includes('src/lib/exam/data.ts') &&
          !file.relPath.includes('answer-keys.server.ts'),
      ),
    ).toBe(true);
    const firstDelete = planned.findIndex((file) => file.delete);
    const lastWrite = planned.reduce((index, file, i) => (file.delete ? index : i), -1);
    expect(firstDelete).toBeGreaterThan(-1);
    expect(lastWrite).toBeGreaterThan(-1);
    expect(lastWrite).toBeLessThan(firstDelete);
    expect(
      planned.findIndex((file) => file.relPath.endsWith('generated/subjects.json')),
    ).toBeLessThan(firstDelete);
    expect(planned.findIndex((file) => file.relPath.endsWith('generated-public.ts'))).toBeLessThan(
      firstDelete,
    );
    expect(
      planned.findIndex((file) => file.relPath.endsWith('generated-keys.server.ts')),
    ).toBeLessThan(firstDelete);

    applyEmit(planned);
    expect(existsSync(leftover.questionsPath)).toBe(false);
    expect(existsSync(leftover.keysPath)).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(generated, 'subjects.json'), 'utf8')).map(
        (s: { id: string }) => s.id,
      ),
    ).toEqual(['biology']);
    expect(readFileSync(path.join(tmp, 'src/lib/exam/generated-public.ts'), 'utf8')).not.toContain(
      'chemistry',
    );
    expect(
      readFileSync(path.join(tmp, 'src/lib/exam/generated-keys.server.ts'), 'utf8'),
    ).not.toContain('chemistry');
    expect(existsSync(path.join(tmp, 'src/lib/exam/data.ts'))).toBe(false);
  });

  it('refuses a malformed or invalid generated subject catalog', () => {
    const validated = validateIrCollection([
      { path: 'biology/bank.ir.json', data: loadBiologyIr() },
    ]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-catalog-'));
    mkdirSync(path.join(tmp, 'content/generated'), { recursive: true });
    writeFileSync(path.join(tmp, 'content/generated/subjects.json'), '{not-json');
    expect(() => planEmit(validated.banks, tmp)).toThrow(
      /failed to read generated subject catalog/,
    );

    writeFileSync(
      path.join(tmp, 'content/generated/subjects.json'),
      `${JSON.stringify([{ id: 'not a kebab id', label: 'X', icon: 'x', l: 0, c: 0, h: 0 }], null, 2)}\n`,
    );
    expect(() => readGeneratedSubjects(tmp)).toThrow(/invalid generated subject catalog/);
  });
});

describe('examify-ingest load + registrars + diffs', () => {
  it('treats only an all-directory argv as an authoritative catalog emit', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-catalog-flag-'));
    mkdirSync(path.join(tmp, 'content/subjects/biology'), { recursive: true });
    writeFileSync(path.join(tmp, 'content/subjects/biology/bank.ir.json'), '{}');
    expect(isAuthoritativeCatalogInput(['content/subjects'], tmp)).toBe(true);
    expect(isAuthoritativeCatalogInput(['content/subjects/biology/bank.ir.json'], tmp)).toBe(false);
    expect(
      isAuthoritativeCatalogInput(
        ['content/subjects/biology/bank.ir.json', 'content/subjects'],
        tmp,
      ),
    ).toBe(false);
    expect(isAuthoritativeCatalogInput(['content/subjects', 'content/subjects'], tmp)).toBe(true);
  });

  it('applyEmit writes catalog and registrars before unlinking leftovers', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-apply-order-'));
    const questionsPath = path.join(tmp, 'content/generated/questions/chemistry.json');
    const registrarPath = path.join(tmp, 'src/lib/exam/generated-public.ts');
    mkdirSync(path.dirname(questionsPath), { recursive: true });
    mkdirSync(path.dirname(registrarPath), { recursive: true });
    writeFileSync(questionsPath, '{}\n');
    writeFileSync(registrarPath, 'export {}\n');

    const applied = applyEmit([
      {
        relPath: 'content/generated/questions/chemistry.json',
        absPath: questionsPath,
        contents: '',
        existing: '{}\n',
        delete: true,
      },
      {
        relPath: 'src/lib/exam/generated-public.ts',
        absPath: registrarPath,
        contents: 'export const GENERATED_QUESTIONS = {};\n',
        existing: 'export {}\n',
      },
    ]);

    expect(applied.map((file) => Boolean(file.delete))).toEqual([false, true]);
    expect(applied.map((file) => file.relPath)).toEqual([
      'src/lib/exam/generated-public.ts',
      'content/generated/questions/chemistry.json',
    ]);
    expect(existsSync(questionsPath)).toBe(false);
    expect(readFileSync(registrarPath, 'utf8')).toBe('export const GENERATED_QUESTIONS = {};\n');
  });

  it('skips missing optional bank.ir.json but surfaces other stat errors', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-load-'));
    mkdirSync(path.join(tmp, 'biology'));
    writeFileSync(
      path.join(tmp, 'biology/bank.ir.json'),
      readFileSync(path.join(repoRoot, 'content/subjects/biology/bank.ir.json')),
    );
    mkdirSync(path.join(tmp, 'empty-subject'));
    expect(resolveIrFiles([tmp], tmp)).toEqual([path.join(tmp, 'biology/bank.ir.json')]);

    expect(() => resolveIrFiles(['missing-ir.json'], tmp)).toThrow(/path not found/);

    const blocked = path.join(tmp, 'blocked');
    mkdirSync(blocked);
    writeFileSync(path.join(blocked, 'bank.ir.json'), '{}');
    chmodSync(blocked, 0);
    try {
      try {
        statSync(path.join(blocked, 'bank.ir.json'));
      } catch {
        expect(() => resolveIrFiles([tmp], tmp)).toThrow(/cannot stat/);
      }
    } finally {
      chmodSync(blocked, 0o755);
    }
  });

  it('uses injective hyphen-to-underscore import aliases', () => {
    const rendered = renderGeneratedPublic([
      { id: 'foo-1', label: 'Foo 1', icon: 'foo', l: 0.5, c: 0.1, h: 40 },
      { id: 'foo1', label: 'Foo1', icon: 'foo', l: 0.5, c: 0.1, h: 40 },
    ]);
    expect(rendered).toContain('import foo_1Questions from');
    expect(rendered).toContain('import foo1Questions from');
    expect(rendered.match(/import foo1Questions/g)?.length).toBe(1);
  });

  it('omits detailed diffs when the LCS table would be too large', () => {
    const lines = Array.from(
      { length: Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 2 },
      (_, i) => `L${i}`,
    );
    const before = `${lines.join('\n')}\n`;
    const after = `${['changed', ...lines.slice(1)].join('\n')}\n`;
    const out = formatFileDiff('content/generated/questions/huge.json', before, after);
    expect(out).toContain('would update content/generated/questions/huge.json');
    expect(out).toContain('(detailed diff omitted; file too large)');
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

  it('USAGE mentions whole-tree prune and partial-safe file argv', () => {
    expect(USAGE).toContain('prunes leftover generated subject JSON');
    expect(USAGE).toContain('mixed');
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

  it('CLI validate refuses a non-fixture sample-bank id without --replace-sample', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-ir-'));
    const irPath = path.join(tmp, 'bank.ir.json');
    writeFileSync(irPath, JSON.stringify(collidingSampleIr('maths-easy-2')), 'utf8');
    const stderr: string[] = [];
    const code = runCli(['validate', irPath], {
      cwd: repoRoot,
      stdout: { write: () => undefined },
      stderr: { write: (chunk) => void stderr.push(chunk) },
    });
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('maths-easy-2');
    expect(stderr.join('')).toContain('--replace-sample');
  });

  it('CLI emit --apply of biology alone keeps another generated subject', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-cli-partial-'));
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    mkdirSync(path.join(tmp, 'content/subjects/biology'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'content/subjects/biology/bank.ir.json'),
      readFileSync(path.join(repoRoot, 'content/subjects/biology/bank.ir.json')),
    );
    const leftover = writeLeftoverChemistry(path.join(tmp, 'content/generated'));

    const code = runCli(['emit', 'content/subjects/biology/bank.ir.json', '--apply'], {
      cwd: tmp,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });
    expect(code).toBe(0);
    const subjects = JSON.parse(
      readFileSync(path.join(tmp, 'content/generated/subjects.json'), 'utf8'),
    ) as { id: string }[];
    expect(subjects.map((subject) => subject.id)).toEqual(['chemistry', 'biology']);
    expect(readFileSync(leftover.questionsPath, 'utf8')).toBe(leftover.questionsBefore);
    expect(readFileSync(leftover.keysPath, 'utf8')).toBe(leftover.keysBefore);
  });

  it('CLI mixed directory + file argv does not prune leftover subjects', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-cli-mixed-'));
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    mkdirSync(path.join(tmp, 'content/subjects/biology'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'content/subjects/biology/bank.ir.json'),
      readFileSync(path.join(repoRoot, 'content/subjects/biology/bank.ir.json')),
    );
    const leftover = writeLeftoverChemistry(path.join(tmp, 'content/generated'));

    const code = runCli(
      ['emit', 'content/subjects', 'content/subjects/biology/bank.ir.json', '--apply'],
      {
        cwd: tmp,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );
    expect(code).toBe(0);
    const subjects = JSON.parse(
      readFileSync(path.join(tmp, 'content/generated/subjects.json'), 'utf8'),
    ) as { id: string }[];
    expect(subjects.map((subject) => subject.id)).toEqual(['chemistry', 'biology']);
    expect(existsSync(leftover.questionsPath)).toBe(true);
    expect(existsSync(leftover.keysPath)).toBe(true);
    expect(readFileSync(leftover.questionsPath, 'utf8')).toBe(leftover.questionsBefore);
    expect(readFileSync(leftover.keysPath, 'utf8')).toBe(leftover.keysBefore);
  });

  it('CLI whole-tree emit dry-run lists leftover deletes; --apply removes them', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-cli-prune-'));
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    mkdirSync(path.join(tmp, 'content/subjects/biology'), { recursive: true });
    mkdirSync(path.join(tmp, 'src/lib/exam'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'content/subjects/biology/bank.ir.json'),
      readFileSync(path.join(repoRoot, 'content/subjects/biology/bank.ir.json')),
    );
    const leftover = writeLeftoverChemistry(path.join(tmp, 'content/generated'));
    writeFileSync(path.join(tmp, 'src/lib/exam/generated-public.ts'), 'export {}\n');
    writeFileSync(path.join(tmp, 'src/lib/exam/generated-keys.server.ts'), 'export {}\n');

    const dryChunks: string[] = [];
    const dryCode = runCli(['emit', 'content/subjects', '--dry-run'], {
      cwd: tmp,
      stdout: { write: (chunk) => void dryChunks.push(chunk) },
      stderr: { write: (chunk) => void dryChunks.push(chunk) },
    });
    expect(dryCode).toBe(0);
    const dryOut = dryChunks.join('');
    expect(dryOut).toContain('would delete content/generated/questions/chemistry.json');
    expect(dryOut).toContain('would delete content/generated/keys/chemistry.json');
    expect(existsSync(leftover.questionsPath)).toBe(true);
    expect(existsSync(leftover.keysPath)).toBe(true);

    const applyChunks: string[] = [];
    const applyCode = runCli(['emit', 'content/subjects', '--apply'], {
      cwd: tmp,
      stdout: { write: (chunk) => void applyChunks.push(chunk) },
      stderr: { write: (chunk) => void applyChunks.push(chunk) },
    });
    expect(applyCode).toBe(0);
    const applyOut = applyChunks.join('');
    expect(applyOut).toContain('deleted content/generated/questions/chemistry.json');
    expect(applyOut).toContain('deleted content/generated/keys/chemistry.json');
    expect(applyOut.indexOf('updated src/lib/exam/generated-public.ts')).toBeLessThan(
      applyOut.indexOf('deleted content/generated/questions/chemistry.json'),
    );
    expect(existsSync(leftover.questionsPath)).toBe(false);
    expect(existsSync(leftover.keysPath)).toBe(false);
    const subjects = JSON.parse(
      readFileSync(path.join(tmp, 'content/generated/subjects.json'), 'utf8'),
    ) as { id: string }[];
    expect(subjects.map((subject) => subject.id)).toEqual(['biology']);
    expect(readFileSync(path.join(tmp, 'src/lib/exam/generated-public.ts'), 'utf8')).toContain(
      'biology',
    );
    expect(readFileSync(path.join(tmp, 'src/lib/exam/generated-public.ts'), 'utf8')).not.toContain(
      'chemistry',
    );
    expect(readFileSync(path.join(tmp, 'src/lib/exam/generated-keys.server.ts'), 'utf8')).toContain(
      'biology',
    );
    expect(
      readFileSync(path.join(tmp, 'src/lib/exam/generated-keys.server.ts'), 'utf8'),
    ).not.toContain('chemistry');
  });
});
