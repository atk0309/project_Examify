import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERATE_SEED,
  NEXT_INGEST_COMMANDS,
  buildCacheKey,
  generateSubject,
  loadGeneratePrompt,
  parseArgs,
  publicSplitHasNoSecrets,
  runCli,
  runCliAsync,
  runManifestSchema,
  splitIr,
  type BankIR,
} from '../../tools/examify-ingest/src/index';

function examifyRepo(): string {
  const tmp = mkdtempSync(path.join(tmpdir(), 'examify-generate-'));
  writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  mkdirSync(path.join(tmp, 'content/subjects/plants'), { recursive: true });
  mkdirSync(path.join(tmp, 'content/source-pdfs/plants'), { recursive: true });
  mkdirSync(path.join(tmp, 'content/generated/questions'), { recursive: true });
  mkdirSync(path.join(tmp, 'content/generated/keys'), { recursive: true });
  writeFileSync(
    path.join(tmp, 'content/subjects/plants/subject.json'),
    `${JSON.stringify({
      id: 'plants',
      label: 'Plants',
      icon: 'biology',
      l: 0.58,
      c: 0.09,
      h: 142,
    })}\n`,
  );
  writeFileSync(
    path.join(tmp, 'content/source-pdfs/plants/notes.txt'),
    'Chloroplasts make sugar.\n',
  );
  writeFileSync(
    path.join(tmp, 'content/generated/subjects.json'),
    `${JSON.stringify([{ id: 'biology', label: 'Biology', icon: 'biology', l: 0.5, c: 0.1, h: 140 }], null, 2)}\n`,
  );
  writeFileSync(path.join(tmp, 'content/generated/questions/biology.json'), '{}\n');
  writeFileSync(path.join(tmp, 'content/generated/keys/biology.json'), '{}\n');
  return tmp;
}

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: () => stdout.join(''),
    err: () => stderr.join(''),
    handle: {
      cwd: '',
      stdout: { write: (chunk: string) => void stdout.push(chunk) },
      stderr: { write: (chunk: string) => void stderr.push(chunk) },
      env: {} as Record<string, string | undefined>,
    },
  };
}

describe('examify-ingest generate parse', () => {
  it('requires --provider and defaults seed to 0', () => {
    const missing = parseArgs(['generate', 'content/subjects']);
    expect('error' in missing).toBe(true);
    if ('error' in missing) expect(missing.error).toContain('--provider');

    const parsed = parseArgs(['generate', '--provider', 'test', 'content/subjects/plants']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.command).toBe('generate');
    expect(parsed.provider).toBe('test');
    expect(parsed.seed).toBe(DEFAULT_GENERATE_SEED);
    expect(parsed.dryRunIr).toBe(false);
    expect(parsed.apply).toBe(false);
  });

  it('refuses --apply on generate', () => {
    const parsed = parseArgs(['generate', '--provider', 'test', '--apply', 'content/subjects']);
    expect('error' in parsed).toBe(true);
    if ('error' in parsed) expect(parsed.error).toContain('never emits');
  });

  it('does not treat generate flags as valid on emit', () => {
    const parsed = parseArgs(['emit', '--provider', 'test', 'content/subjects']);
    expect('error' in parsed).toBe(true);
  });
});

describe('examify-ingest generate', () => {
  it('test provider: same seed + sources → identical IR and cacheKey hit', async () => {
    const root = examifyRepo();
    const streams = io();
    streams.handle.cwd = root;

    const first = await runCliAsync(
      ['generate', '--provider', 'test', '--seed', '0', 'content/subjects/plants'],
      streams.handle,
    );
    expect(first).toBe(0);
    const irPath = path.join(root, 'content/subjects/plants/bank.ir.json');
    expect(existsSync(irPath)).toBe(true);
    const ir1 = JSON.parse(readFileSync(irPath, 'utf8')) as BankIR;
    expect(ir1.subject.id).toBe('plants');
    expect(ir1.meta?.seed).toBe(0);
    expect(ir1.meta?.provider).toBe('test');

    const secondStreams = io();
    secondStreams.handle.cwd = root;
    const second = await runCliAsync(
      ['generate', '--provider', 'test', '--seed', '0', 'content/subjects/plants'],
      secondStreams.handle,
    );
    expect(second).toBe(0);
    expect(secondStreams.out()).toContain('cache hit');
    const ir2 = JSON.parse(readFileSync(irPath, 'utf8')) as BankIR;
    expect(ir2).toEqual(ir1);

    const prompt = loadGeneratePrompt();
    const expectedKey = buildCacheKey({
      promptVersion: prompt.version,
      promptHash: prompt.hash,
      provider: 'test',
      model: 'fixture-v1',
      seed: 0,
      sourceHashes: ir1.meta?.sourceHashes ?? {},
      subject: ir1.subject,
    });
    expect(secondStreams.out()).toContain(expectedKey);
  });

  it('missing API key for anthropic/openai exits non-zero and writes no IR', async () => {
    const root = examifyRepo();
    for (const provider of ['anthropic', 'openai'] as const) {
      const plants = path.join(root, `content/subjects/${provider}-miss`);
      mkdirSync(plants, { recursive: true });
      writeFileSync(path.join(plants, 'notes.txt'), 'source\n');
      const streams = io();
      streams.handle.cwd = root;
      streams.handle.env = { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' };
      const code = await runCliAsync(['generate', '--provider', provider, plants], streams.handle);
      expect(code).toBe(1);
      expect(streams.err()).toMatch(/missing (ANTHROPIC_API_KEY|OPENAI_API_KEY)/);
      expect(existsSync(path.join(plants, 'bank.ir.json'))).toBe(false);
      expect(existsSync(path.join(root, 'content/generated/questions/biology.json'))).toBe(true);
    }
  });

  it('treats the ANTHROPIC_API_KEY=test sentinel as missing for --provider anthropic', async () => {
    const root = examifyRepo();
    const streams = io();
    streams.handle.cwd = root;
    streams.handle.env = { ANTHROPIC_API_KEY: 'test' };
    const code = await runCliAsync(
      ['generate', '--provider', 'anthropic', 'content/subjects/plants'],
      streams.handle,
    );
    expect(code).toBe(1);
    expect(streams.err()).toContain('sentinel');
    expect(existsSync(path.join(root, 'content/subjects/plants/bank.ir.json'))).toBe(false);
  });

  it('generate does not call emit/apply or mutate content/generated', async () => {
    const root = examifyRepo();
    const generatedBefore = {
      subjects: readFileSync(path.join(root, 'content/generated/subjects.json'), 'utf8'),
      questions: readFileSync(path.join(root, 'content/generated/questions/biology.json'), 'utf8'),
      keys: readFileSync(path.join(root, 'content/generated/keys/biology.json'), 'utf8'),
    };
    const streams = io();
    streams.handle.cwd = root;
    const code = await runCliAsync(
      ['generate', '--provider', 'test', 'content/subjects/plants'],
      streams.handle,
    );
    expect(code).toBe(0);
    expect(streams.out()).toContain('Generate writes BankIR only');
    for (const command of NEXT_INGEST_COMMANDS) {
      expect(streams.out()).toContain(command);
    }
    expect(streams.out()).not.toContain('content/generated/questions/plants.json');
    expect(readFileSync(path.join(root, 'content/generated/subjects.json'), 'utf8')).toBe(
      generatedBefore.subjects,
    );
    expect(readFileSync(path.join(root, 'content/generated/questions/biology.json'), 'utf8')).toBe(
      generatedBefore.questions,
    );
    expect(readFileSync(path.join(root, 'content/generated/keys/biology.json'), 'utf8')).toBe(
      generatedBefore.keys,
    );
    expect(existsSync(path.join(root, 'content/generated/questions/plants.json'))).toBe(false);
  });

  it('sync runCli does not run generate (async entry is required)', () => {
    const streams = io();
    const code = runCli(['generate', '--provider', 'test', 'content/subjects'], {
      cwd: process.cwd(),
      stdout: streams.handle.stdout,
      stderr: streams.handle.stderr,
    });
    expect(code).toBe(2);
    expect(streams.err()).toContain('runCliAsync');
  });

  it('public split of generated IR has no answer/rubric fields', async () => {
    const root = examifyRepo();
    const result = await generateSubject({
      repoRoot: root,
      subject: {
        id: 'plants',
        label: 'Plants',
        icon: 'biology',
        l: 0.58,
        c: 0.09,
        h: 142,
      },
      subjectDir: path.join(root, 'content/subjects/plants'),
      sources: [
        {
          absPath: path.join(root, 'content/source-pdfs/plants/notes.txt'),
          relPath: 'content/source-pdfs/plants/notes.txt',
          sha256: 'abc',
          bytes: Buffer.from('Chloroplasts make sugar.\n'),
          kind: 'text',
          mediaType: 'text/plain',
        },
      ],
      provider: 'test',
      seed: 0,
      env: {},
    });
    expect(publicSplitHasNoSecrets(result.bank)).toBe(true);
    const split = splitIr(result.bank);
    const publicJson = JSON.stringify(split.questions);
    expect(publicJson).not.toContain('"answer"');
    expect(publicJson).not.toContain('"rubric"');
    expect(publicJson).not.toContain('"maxScore"');
    expect(publicJson).not.toContain('"provenance"');
    expect(Object.keys(split.keys['plants-easy-1']!).sort()).toEqual([
      'answer',
      'provenance',
      'type',
    ]);
  });

  it('--dry-run-ir writes a manifest but not bank.ir.json', async () => {
    const root = examifyRepo();
    const streams = io();
    streams.handle.cwd = root;
    const code = await runCliAsync(
      ['generate', '--provider', 'test', '--dry-run-ir', 'content/subjects/plants'],
      streams.handle,
    );
    expect(code).toBe(0);
    expect(existsSync(path.join(root, 'content/subjects/plants/bank.ir.json'))).toBe(false);
    expect(streams.out()).toContain('would write');
    const runs = readdirSync(path.join(root, '.examify-ingest/runs'));
    expect(runs.length).toBe(1);
    const manifest = runManifestSchema.parse(
      JSON.parse(readFileSync(path.join(root, '.examify-ingest/runs', runs[0]!), 'utf8')),
    );
    expect(manifest.provider).toBe('test');
    expect(manifest.temperature).toBe(0);
    expect(manifest.seed).toBe(0);
    expect(manifest.hasApiKey).toBe(false);
    expect(manifest.keyEnv).toBeNull();
  });

  it('never writes API key values into IR, manifest, or cache', async () => {
    const root = examifyRepo();
    const secret = 'sk-ant-leaky-secret-value-12345';
    const bank: BankIR = {
      version: 1,
      subject: { id: 'plants', label: 'Plants', icon: 'biology', l: 0.58, c: 0.09, h: 142 },
      difficulties: {
        easy: [
          {
            id: 'plants-easy-1',
            type: 'mcq',
            q: 'What colour are most leaves?',
            choices: ['Blue', 'Green', 'Red', 'White'],
            answer: 1,
            provenance: { pdf: 'notes.txt', locator: 'p1' },
          },
        ],
        medium: [],
        hard: [],
      },
    };
    const result = await generateSubject({
      repoRoot: root,
      subject: bank.subject,
      subjectDir: path.join(root, 'content/subjects/plants'),
      sources: [
        {
          absPath: path.join(root, 'content/source-pdfs/plants/notes.txt'),
          relPath: 'content/source-pdfs/plants/notes.txt',
          sha256: 'abc',
          bytes: Buffer.from('leaves\n'),
          kind: 'text',
          mediaType: 'text/plain',
        },
      ],
      provider: 'anthropic',
      seed: 0,
      env: { ANTHROPIC_API_KEY: secret },
      fetch: async (input, init) => {
        const url = String(input);
        expect(url).toContain('anthropic.com');
        const headers = new Headers(init?.headers);
        expect(headers.get('x-api-key')).toBe(secret);
        const body = JSON.parse(String(init?.body)) as { temperature: number };
        expect(body.temperature).toBe(0);
        expect(JSON.stringify(body)).not.toContain(secret);
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(bank) }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    expect(result.wroteIr).toBe(true);
    expect(result.manifest.hasApiKey).toBe(true);
    expect(result.manifest.keyEnv).toBe('ANTHROPIC_API_KEY');
    const written = [
      readFileSync(result.irPath, 'utf8'),
      readFileSync(result.manifestPath, 'utf8'),
      readFileSync(path.join(root, '.examify-ingest/cache/ir', `${result.cacheKey}.json`), 'utf8'),
    ].join('\n');
    expect(written).not.toContain(secret);
    expect(written).not.toContain('sk-ant-');
  });

  it('local provider fails closed without EXAMIFY_INGEST_LOCAL_CMD or EXAMIFY_LLM_BASE_URL', async () => {
    const root = examifyRepo();
    const streams = io();
    streams.handle.cwd = root;
    streams.handle.env = {};
    const code = await runCliAsync(
      ['generate', '--provider', 'local', 'content/subjects/plants'],
      streams.handle,
    );
    expect(code).toBe(1);
    expect(streams.err()).toContain('EXAMIFY_INGEST_LOCAL_CMD');
    expect(existsSync(path.join(root, 'content/subjects/plants/bank.ir.json'))).toBe(false);
  });

  it('openai adapter sends temperature 0 and keeps the key out of the body', async () => {
    const root = examifyRepo();
    const secret = 'sk-openai-leaky-secret-value-999';
    const bank: BankIR = {
      version: 1,
      subject: { id: 'plants', label: 'Plants', icon: 'biology', l: 0.58, c: 0.09, h: 142 },
      difficulties: {
        easy: [
          {
            id: 'plants-easy-1',
            type: 'mcq',
            q: 'Fixture?',
            choices: ['A', 'B', 'C', 'D'],
            answer: 0,
            provenance: { pdf: 'notes.txt', locator: 'p1' },
          },
        ],
        medium: [],
        hard: [],
      },
    };
    const result = await generateSubject({
      repoRoot: root,
      subject: bank.subject,
      subjectDir: path.join(root, 'content/subjects/plants'),
      sources: [
        {
          absPath: path.join(root, 'content/source-pdfs/plants/notes.txt'),
          relPath: 'content/source-pdfs/plants/notes.txt',
          sha256: 'abc',
          bytes: Buffer.from('leaves\n'),
          kind: 'text',
          mediaType: 'text/plain',
        },
      ],
      provider: 'openai',
      seed: 7,
      env: { OPENAI_API_KEY: secret },
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe(`Bearer ${secret}`);
        const body = JSON.parse(String(init?.body)) as { temperature: number; seed: number };
        expect(body.temperature).toBe(0);
        expect(body.seed).toBe(7);
        expect(JSON.stringify(body)).not.toContain(secret);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(bank) } }] }),
          { status: 200 },
        );
      },
    });
    expect(readFileSync(result.irPath, 'utf8')).not.toContain(secret);
    expect(result.manifest.temperature).toBe(0);
  });
});
