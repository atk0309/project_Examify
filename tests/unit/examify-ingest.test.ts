import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
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
  sampleBankFrozenIds,
  formatFileDiff,
  isAuthoritativeCatalogInput,
  formatValidateOk,
  parseArgs,
  planEmit,
  readGeneratedSubjects,
  formatDataDirDisplay,
  resolveIngestRoot,
  resolveIrFiles,
  runCli,
  USAGE,
  splitIr,
  validateIrCollection,
  writeFileAtomic,
  type BankIR,
  type PlannedFile,
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

  it('sampleBankFrozenIds is the same set validate/emit freeze', () => {
    expect(sampleBankFrozenIds()).toEqual(SAMPLE_IDS);
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

    const planned = planEmit(validated.banks, tmp, { pruneMissing: true, registrars: true });
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

    const emptyTree = mkdtempSync(path.join(tmpdir(), 'examify-empty-tree-'));
    mkdirSync(path.join(emptyTree, 'leftover-subject'));
    expect(() => resolveIrFiles([emptyTree], emptyTree)).toThrow(/no \*\/bank\.ir\.json/);
    expect(resolveIrFiles([emptyTree], emptyTree, { allowEmptyDirectory: true })).toEqual([]);

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

  it('USAGE says generate sources include notes/text in the subject folder', () => {
    expect(USAGE).toMatch(/notes\/text|\.txt\/\.md/);
    expect(USAGE).toContain('subject folder');
    expect(USAGE).toContain('PDF');
    expect(USAGE).toMatch(/Corrupt \/[\s\S]*--force/);
    expect(USAGE).toContain('zero-item');
  });

  it('docs happy path is validate/emit with content/subjects, not bare argv', () => {
    const authoring = readFileSync(path.join(repoRoot, 'docs/content-authoring.md'), 'utf8');
    const ingestReadme = readFileSync(
      path.join(repoRoot, 'tools/examify-ingest/README.md'),
      'utf8',
    );
    for (const text of [authoring, ingestReadme]) {
      expect(text).toContain('pnpm examify-ingest validate content/subjects');
      expect(text).toContain('pnpm examify-ingest emit content/subjects --dry-run');
      expect(text).not.toMatch(/pnpm examify-ingest validate(?! (?:data\/)?content\/subjects)/);
      expect(text).not.toMatch(/pnpm examify-ingest emit(?! (?:data\/)?content\/subjects)/);
      expect(text).not.toMatch(/`emit --dry-run`/);
      expect(text).not.toMatch(/→ emit --dry-run →/);
    }
  });

  it('validate succeeds on content/subjects', () => {
    const chunks: string[] = [];
    const code = runCli(['validate', 'content/subjects'], {
      cwd: repoRoot,
      stdout: { write: (chunk) => void chunks.push(chunk) },
      stderr: { write: (chunk) => void chunks.push(chunk) },
    });
    expect(code).toBe(0);
    // Tip catalog size is not frozen — a leftover demo IR must not flake this smoke.
    expect(chunks.join('')).toMatch(/ok \d+ BankIR files?/);
  });

  it('validate ok banner is singular for one BankIR file and plural otherwise', () => {
    expect(formatValidateOk(1)).toBe('ok 1 BankIR file');
    expect(formatValidateOk(1)).not.toContain('files');
    expect(formatValidateOk(2)).toBe('ok 2 BankIR files');
    expect(formatValidateOk(3)).toBe('ok 3 BankIR files');
  });

  it('CLI validate uses singular copy for a one-file catalog', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-cli-validate-one-'));
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    const subjectsDir = path.join(tmp, 'content/subjects');
    mkdirSync(path.join(subjectsDir, 'biology'), { recursive: true });
    writeFileSync(
      path.join(subjectsDir, 'biology/bank.ir.json'),
      readFileSync(path.join(repoRoot, 'content/subjects/biology/bank.ir.json')),
    );

    const chunks: string[] = [];
    const errors: string[] = [];
    const code = runCli(['validate', 'content/subjects'], {
      cwd: tmp,
      env: {},
      stdout: { write: (chunk) => void chunks.push(chunk) },
      stderr: { write: (chunk) => void errors.push(chunk) },
    });
    expect(code).toBe(0);
    // Prefix match would also pass "ok 1 BankIR files" — require the exact singular line.
    expect(chunks.join('')).toBe('ok 1 BankIR file\n');
    expect(errors.join('')).toBe('layer: committed (checkout)\n');
  });

  it('CLI validate reports BankIR file count from the catalog it was given', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-cli-validate-count-'));
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    const subjectsDir = path.join(tmp, 'content/subjects');
    mkdirSync(path.join(subjectsDir, 'biology'), { recursive: true });
    writeFileSync(
      path.join(subjectsDir, 'biology/bank.ir.json'),
      readFileSync(path.join(repoRoot, 'content/subjects/biology/bank.ir.json')),
    );
    mkdirSync(path.join(subjectsDir, 'demo'), { recursive: true });
    writeFileSync(
      path.join(subjectsDir, 'demo/bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'demo', label: 'Demo', icon: 'demo', l: 0.5, c: 0.05, h: 150 },
        difficulties: {
          easy: [
            {
              id: 'demo-easy-1',
              type: 'mcq',
              q: 'Fixture question?',
              choices: ['A', 'B', 'C', 'D'],
              answer: 0,
              provenance: { pdf: 'hand-authored', locator: 'fixture' },
            },
          ],
          medium: [],
          hard: [],
        },
      } satisfies BankIR),
    );

    const chunks: string[] = [];
    const code = runCli(['validate', 'content/subjects'], {
      cwd: tmp,
      env: {},
      stdout: { write: (chunk) => void chunks.push(chunk) },
      stderr: { write: () => undefined },
    });
    expect(code).toBe(0);
    expect(chunks.join('')).toBe('ok 2 BankIR files\n');
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
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    const irPath = path.join(tmp, 'bank.ir.json');
    writeFileSync(irPath, JSON.stringify(collidingSampleIr('maths-easy-2')), 'utf8');
    const stderr: string[] = [];
    const code = runCli(['validate', irPath], {
      cwd: tmp,
      env: {},
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

  it('CLI mixed empty directory + file argv still fails and does not prune', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-cli-empty-mixed-'));
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    mkdirSync(path.join(tmp, 'content/subjects'), { recursive: true });
    const leftover = writeLeftoverChemistry(path.join(tmp, 'content/generated'));
    const irPath = path.join(tmp, 'biology.ir.json');
    writeFileSync(
      irPath,
      readFileSync(path.join(repoRoot, 'content/subjects/biology/bank.ir.json')),
    );

    const stderr: string[] = [];
    const code = runCli(['emit', 'content/subjects', irPath, '--apply'], {
      cwd: tmp,
      stdout: { write: () => undefined },
      stderr: { write: (chunk) => void stderr.push(chunk) },
    });
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/no \*\/bank\.ir\.json/);
    expect(existsSync(leftover.questionsPath)).toBe(true);
    expect(readFileSync(leftover.questionsPath, 'utf8')).toBe(leftover.questionsBefore);
  });

  it('CLI validate of an empty subjects directory still fails', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-cli-empty-validate-'));
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    mkdirSync(path.join(tmp, 'content/subjects'), { recursive: true });
    const stderr: string[] = [];
    const code = runCli(['validate', 'content/subjects'], {
      cwd: tmp,
      stdout: { write: () => undefined },
      stderr: { write: (chunk) => void stderr.push(chunk) },
    });
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/no \*\/bank\.ir\.json/);
  });

  it('CLI emit of an empty subjects directory fails closed and leaves generated files', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'examify-cli-empty-emit-'));
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    mkdirSync(path.join(tmp, 'content/subjects/biology'), { recursive: true });
    mkdirSync(path.join(tmp, 'src/lib/exam'), { recursive: true });
    const leftover = writeLeftoverChemistry(path.join(tmp, 'content/generated'));
    const registrarBefore = 'export {}\n';
    writeFileSync(path.join(tmp, 'src/lib/exam/generated-public.ts'), registrarBefore);
    writeFileSync(path.join(tmp, 'src/lib/exam/generated-keys.server.ts'), registrarBefore);
    const subjectsBefore = readFileSync(path.join(tmp, 'content/generated/subjects.json'), 'utf8');

    const stderr: string[] = [];
    const code = runCli(['emit', 'content/subjects', '--apply'], {
      cwd: tmp,
      stdout: { write: () => undefined },
      stderr: { write: (chunk) => void stderr.push(chunk) },
    });
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/will not wipe generated content/);
    expect(existsSync(leftover.questionsPath)).toBe(true);
    expect(existsSync(leftover.keysPath)).toBe(true);
    expect(readFileSync(leftover.questionsPath, 'utf8')).toBe(leftover.questionsBefore);
    expect(readFileSync(leftover.keysPath, 'utf8')).toBe(leftover.keysBefore);
    expect(readFileSync(path.join(tmp, 'content/generated/subjects.json'), 'utf8')).toBe(
      subjectsBefore,
    );
    expect(readFileSync(path.join(tmp, 'src/lib/exam/generated-public.ts'), 'utf8')).toBe(
      registrarBefore,
    );
    expect(readFileSync(path.join(tmp, 'src/lib/exam/generated-keys.server.ts'), 'utf8')).toBe(
      registrarBefore,
    );
  });
});

const REGISTRAR_PUBLIC = 'src/lib/exam/generated-public.ts';
const REGISTRAR_KEYS = 'src/lib/exam/generated-keys.server.ts';

function historyIr(): BankIR {
  return {
    version: 1,
    subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
    difficulties: {
      easy: [
        {
          id: 'history-easy-1',
          type: 'mcq',
          q: 'A family history question?',
          choices: ['A', 'B', 'C', 'D'],
          answer: 1,
          provenance: { pdf: 'hand-authored', locator: 'unit' },
        },
      ],
      medium: [],
      hard: [],
    },
  };
}

/**
 * A fake checkout with committed biology (IR, generated JSON, registrars) and
 * an empty default family data folder (`./data`).
 */
function fakeCheckout(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'examify-layers-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  mkdirSync(path.join(root, 'content/subjects/biology'), { recursive: true });
  writeFileSync(
    path.join(root, 'content/subjects/biology/bank.ir.json'),
    readFileSync(path.join(repoRoot, 'content/subjects/biology/bank.ir.json')),
  );
  for (const rel of [
    'content/generated/subjects.json',
    'content/generated/questions/biology.json',
    'content/generated/keys/biology.json',
  ]) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), readFileSync(path.join(repoRoot, rel)));
  }
  mkdirSync(path.join(root, 'src/lib/exam'), { recursive: true });
  writeFileSync(path.join(root, REGISTRAR_PUBLIC), '// committed public registrar\n');
  writeFileSync(path.join(root, REGISTRAR_KEYS), '// committed keys registrar\n');
  return root;
}

function writeFamilyIr(dataDir: string, ir: BankIR): void {
  const dir = path.join(dataDir, 'content/subjects', ir.subject.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'bank.ir.json'), JSON.stringify(ir));
}

/** Every file under `dir` (relative path → bytes), for before/after comparisons. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else out[path.relative(dir, child)] = readFileSync(child, 'utf8');
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function checkoutBytes(root: string): Record<string, string> {
  return {
    ...snapshotTree(path.join(root, 'content/generated')),
    [REGISTRAR_PUBLIC]: readFileSync(path.join(root, REGISTRAR_PUBLIC), 'utf8'),
    [REGISTRAR_KEYS]: readFileSync(path.join(root, REGISTRAR_KEYS), 'utf8'),
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: () => out.join(''),
    err: () => err.join(''),
    stdout: { write: (chunk: string) => void out.push(chunk) },
    stderr: { write: (chunk: string) => void err.push(chunk) },
  };
}

function mode(abs: string): number {
  return statSync(abs).mode & 0o777;
}

describe('examify-ingest layers', () => {
  it('names the data folder relative to the checkout when it is inside it', () => {
    expect(formatDataDirDisplay('/srv/examify', '/srv/examify/data')).toBe('data');
    expect(formatDataDirDisplay('/srv/examify', '/srv/examify/data/family')).toBe('data/family');
    expect(formatDataDirDisplay('/srv/examify', '/var/lib/examify')).toBe('/var/lib/examify');
    expect(formatDataDirDisplay('/srv/examify', '/srv/examify-data')).toBe('/srv/examify-data');
  });

  it('classifies paths: data folder first, then the checkout, else refuse', () => {
    const root = fakeCheckout();
    writeFamilyIr(path.join(root, 'data'), historyIr());
    const outside = mkdtempSync(path.join(tmpdir(), 'examify-layers-data-'));
    writeFamilyIr(outside, historyIr());

    expect(resolveIngestRoot(['content/subjects'], root, {})).toMatchObject({
      layer: 'committed',
      root,
      repoRoot: root,
      dataDirDisplay: 'data',
    });
    // `./data` is inside the checkout, but the data folder wins.
    expect(resolveIngestRoot(['data/content/subjects'], root, {})).toMatchObject({
      layer: 'family',
      root: path.join(root, 'data'),
      repoRoot: root,
    });
    expect(
      resolveIngestRoot([path.join(outside, 'content/subjects')], root, {
        EXAMIFY_DATA_DIR: outside,
      }),
    ).toMatchObject({ layer: 'family', root: outside, repoRoot: root, dataDirDisplay: outside });
    // A symlink in the checkout that points into the data folder is the family layer.
    symlinkSync(outside, path.join(root, 'family-link'));
    expect(
      resolveIngestRoot(['family-link/content/subjects'], root, { EXAMIFY_DATA_DIR: outside }),
    ).toMatchObject({ layer: 'family', root: outside });

    expect(() => resolveIngestRoot([path.join(outside, 'content/subjects')], root, {})).toThrow(
      'path is outside the checkout and the family data folder',
    );
    expect(() =>
      resolveIngestRoot(['content/subjects', 'data/content/subjects'], root, {}),
    ).toThrow('inputs span the family data folder and the checkout; run them separately');
    // A leftover ./data after the data folder moved is never the committed layer.
    expect(() =>
      resolveIngestRoot(['data/content/subjects'], root, { EXAMIFY_DATA_DIR: outside }),
    ).toThrow(`this path is under ./data, but the family data folder is ${outside}`);
  });

  it('refuses a database or mail outbox inside the checkout, like the app', () => {
    const root = fakeCheckout();
    expect(() =>
      resolveIngestRoot(['content/subjects'], root, { DATABASE_URL: 'file:./app.db' }),
    ).toThrow('DATABASE_URL points inside the checkout');
    writeFileSync(path.join(root, '.env'), 'MAIL_OUTBOX_DIR=outbox\n');
    expect(() => resolveIngestRoot(['content/subjects'], root, {})).toThrow(
      'MAIL_OUTBOX_DIR points inside the checkout',
    );
  });

  it('warns when the family folder belongs to another user', async () => {
    const { familyFolderOwnerWarning } = await import('../../tools/examify-ingest/src/cli');
    const dataDir = mkdtempSync(path.join(tmpdir(), 'examify-layers-owner-'));
    const me = statSync(dataDir).uid;
    expect(familyFolderOwnerWarning({ layer: 'family', dataDir }, () => me)).toBeNull();
    expect(familyFolderOwnerWarning({ layer: 'family', dataDir }, () => me + 1)).toContain(
      'belongs to another user',
    );
    expect(familyFolderOwnerWarning({ layer: 'committed', dataDir }, () => me + 1)).toBeNull();
  });

  it('reads the data folder from the checkout env files like the app', () => {
    const root = fakeCheckout();
    const outside = mkdtempSync(path.join(tmpdir(), 'examify-layers-envfile-'));
    writeFileSync(path.join(root, '.env'), `EXAMIFY_DATA_DIR=${outside}\n`);
    writeFamilyIr(outside, historyIr());
    expect(resolveIngestRoot([path.join(outside, 'content/subjects')], root, {})).toMatchObject({
      layer: 'family',
      root: outside,
    });
  });

  it('refuses a mixed or outside run before reading anything', () => {
    const root = fakeCheckout();
    writeFamilyIr(path.join(root, 'data'), historyIr());
    const mixed = capture();
    expect(
      runCli(['validate', 'content/subjects', 'data/content/subjects'], {
        cwd: root,
        env: {},
        ...mixed,
      }),
    ).toBe(1);
    expect(mixed.err()).toContain('run them separately');
    expect(mixed.out()).toBe('');

    const elsewhere = mkdtempSync(path.join(tmpdir(), 'examify-layers-elsewhere-'));
    writeFamilyIr(elsewhere, historyIr());
    const outside = capture();
    expect(
      runCli(['emit', path.join(elsewhere, 'content/subjects'), '--apply'], {
        cwd: root,
        env: {},
        ...outside,
      }),
    ).toBe(1);
    expect(outside.err()).toContain('path is outside the checkout and the family data folder');
    expect(existsSync(path.join(elsewhere, 'content/generated'))).toBe(false);
  });

  it('family emit writes only <data>/content/generated (keys 0600 in 0700), never registrars', () => {
    const root = fakeCheckout();
    const data = path.join(root, 'data');
    writeFamilyIr(data, historyIr());
    writeFamilyIr(data, loadBiologyIr());
    const before = checkoutBytes(root);

    const dry = capture();
    expect(
      runCli(['emit', 'data/content/subjects', '--dry-run'], { cwd: root, env: {}, ...dry }),
    ).toBe(0);
    expect(dry.err()).toContain('layer: family (data)\n');
    expect(dry.err()).toContain(
      'note: family subject biology replaces the committed subject biology',
    );
    expect(dry.out()).not.toContain('generated-public.ts');
    expect(dry.out()).not.toContain('generated-keys.server.ts');

    const apply = capture();
    expect(
      runCli(['emit', 'data/content/subjects', '--apply'], { cwd: root, env: {}, ...apply }),
    ).toBe(0);
    expect(apply.err()).not.toContain('writes tracked files');
    expect(checkoutBytes(root)).toEqual(before);
    expect(Object.keys(snapshotTree(path.join(data, 'content/generated'))).sort()).toEqual([
      'keys/biology.json',
      'keys/history.json',
      'questions/biology.json',
      'questions/history.json',
      'subjects.json',
    ]);
    expect(mode(path.join(data, 'content/generated/keys'))).toBe(0o700);
    expect(mode(path.join(data, 'content/generated/keys/history.json'))).toBe(0o600);
    expect(mode(path.join(data, 'content/generated/keys/biology.json'))).toBe(0o600);
    expect(existsSync(path.join(data, 'src'))).toBe(false);
  });

  it('family emit never plans registrars even when the data folder has some', () => {
    const root = fakeCheckout();
    const data = path.join(root, 'data');
    writeFamilyIr(data, historyIr());
    mkdirSync(path.join(data, 'src/lib/exam'), { recursive: true });
    writeFileSync(path.join(data, REGISTRAR_PUBLIC), 'export {}\n');
    const apply = capture();
    expect(
      runCli(['emit', 'data/content/subjects', '--apply'], { cwd: root, env: {}, ...apply }),
    ).toBe(0);
    expect(readFileSync(path.join(data, REGISTRAR_PUBLIC), 'utf8')).toBe('export {}\n');
    expect(apply.out()).not.toContain('src/lib/exam');
  });

  it('committed emit --apply still rewrites registrars and says it writes tracked files', () => {
    const root = fakeCheckout();
    mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify(historyIr()),
    );
    const apply = capture();
    expect(runCli(['emit', 'content/subjects', '--apply'], { cwd: root, env: {}, ...apply })).toBe(
      0,
    );
    expect(apply.err()).toContain('layer: committed (checkout)\n');
    expect(apply.err()).toContain(
      'note: this writes tracked files in the checkout (committed content). Family content belongs in data/content/subjects.',
    );
    expect(readFileSync(path.join(root, REGISTRAR_PUBLIC), 'utf8')).toContain('history');
    expect(readFileSync(path.join(root, REGISTRAR_KEYS), 'utf8')).toContain('history');
    expect(existsSync(path.join(root, 'data'))).toBe(false);
  });
});

describe('examify-ingest emit writes', () => {
  it('planEmit plans registrars only with registrars: true', () => {
    const validated = validateIrCollection([{ path: 'history/bank.ir.json', data: historyIr() }]);
    if (!validated.ok) throw new Error('fixture must validate');
    const root = fakeCheckout();
    const rels = (files: PlannedFile[]) => files.map((file) => file.relPath);
    expect(rels(planEmit(validated.banks, root))).not.toContain(REGISTRAR_PUBLIC);
    expect(rels(planEmit(validated.banks, root, { registrars: false }))).not.toContain(
      REGISTRAR_KEYS,
    );
    expect(rels(planEmit(validated.banks, root, { registrars: true }))).toEqual(
      expect.arrayContaining([REGISTRAR_PUBLIC, REGISTRAR_KEYS]),
    );
  });

  it('applies questions + keys, then registrars, then subjects.json, then unlinks', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'examify-apply-rank-'));
    const file = (relPath: string, extra: Partial<PlannedFile> = {}): PlannedFile => ({
      relPath,
      absPath: path.join(root, relPath),
      contents: `${relPath}\n`,
      existing: null,
      ...extra,
    });
    mkdirSync(path.join(root, 'content/generated/questions'), { recursive: true });
    writeFileSync(path.join(root, 'content/generated/questions/old.json'), '{}\n');
    const applied = applyEmit([
      file('content/generated/subjects.json'),
      file('content/generated/questions/old.json', { delete: true, contents: '', existing: '{}' }),
      file(REGISTRAR_PUBLIC),
      file('content/generated/questions/history.json'),
      file('content/generated/keys/history.json'),
    ]);
    expect(applied.map((entry) => entry.relPath)).toEqual([
      'content/generated/questions/history.json',
      'content/generated/keys/history.json',
      REGISTRAR_PUBLIC,
      'content/generated/subjects.json',
      'content/generated/questions/old.json',
    ]);
    expect(mode(path.join(root, 'content/generated/keys/history.json'))).toBe(0o600);
    expect(mode(path.join(root, 'content/generated/keys'))).toBe(0o700);
    // Atomic writes leave no temp files behind.
    expect(readdirSync(path.join(root, 'content/generated/keys'))).toEqual(['history.json']);
  });

  it('tightens an unchanged keys file without counting it as written', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'examify-apply-tighten-'));
    const keysPath = path.join(root, 'content/generated/keys/history.json');
    mkdirSync(path.dirname(keysPath), { recursive: true, mode: 0o755 });
    writeFileSync(keysPath, '{}\n', { mode: 0o644 });
    chmodSync(keysPath, 0o644);
    const applied = applyEmit([
      {
        relPath: 'content/generated/keys/history.json',
        absPath: keysPath,
        contents: '{}\n',
        existing: '{}\n',
      },
    ]);
    expect(applied).toEqual([]);
    expect(mode(keysPath)).toBe(0o600);
    expect(mode(path.dirname(keysPath))).toBe(0o700);
  });

  it('writeFileAtomic sets the requested mode and replaces the file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'examify-atomic-mode-'));
    const target = path.join(dir, 'keys.json');
    writeFileSync(target, 'old\n');
    chmodSync(target, 0o644);
    writeFileAtomic(target, 'new\n', { mode: 0o600 });
    expect(readFileSync(target, 'utf8')).toBe('new\n');
    expect(mode(target)).toBe(0o600);
    writeFileAtomic(path.join(dir, 'plain.json'), 'x\n');
    expect(readdirSync(dir).sort()).toEqual(['keys.json', 'plain.json']);
  });
});
