import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { openaiProvider } from '../../tools/examify-ingest/src/providers/openai';
import {
  openAiBankIrResponseFormat,
  strictWireSchema,
} from '../../tools/examify-ingest/src/providers/openai-schema';
import {
  parseProviderBankIr,
  type ProviderRequest,
} from '../../tools/examify-ingest/src/providers/types';
import { semanticOutputDiagnostic } from '../../tools/examify-ingest/src/output-diagnostic';
import { DIFFICULTIES } from '../../tools/examify-ingest/src/schema';
import { splitIr } from '../../tools/examify-ingest/src/split';
import { validateIrCollection } from '../../tools/examify-ingest/src/validate';

const bank = {
  version: 1,
  subject: { id: 'demo', label: 'Demo', icon: 'biology', l: 0.6, c: 0.1, h: 50 },
  difficulties: {
    easy: [
      {
        id: 'demo-easy-1',
        type: 'mcq',
        q: 'Fixture?',
        choices: ['a', 'b', 'c', 'd'],
        answer: 0,
        provenance: { pdf: 'notes.txt', locator: 'section 1' },
      },
    ],
    medium: [
      {
        id: 'demo-medium-free-1',
        type: 'free',
        q: 'Explain?',
        rubric: 'One mark for fixture.',
        maxScore: 1,
        provenance: { pdf: 'notes.txt', locator: 'section 1' },
      },
    ],
    hard: [],
  },
};
const request: ProviderRequest = {
  provider: 'openai',
  model: 'gpt-4o',
  seed: 0,
  temperature: 0,
  prompt: 'Only JSON BankIR',
  promptVersion: 'v2',
  subject: bank.subject,
  sources: [],
  pageImages: [],
};
async function generate(
  content: unknown,
  finish_reason: string | undefined = 'stop',
  refusal?: string,
) {
  let calls = 0;
  let wire: Record<string, unknown> = {};
  try {
    const result = await openaiProvider.generate(request, {
      env: { OPENAI_API_KEY: 'fixture-never-sent' },
      fetch: async (_url, init) => {
        calls++;
        wire = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ choices: [{ finish_reason, message: { content, refusal } }] }),
          { status: 200 },
        );
      },
    });
    return { result, calls, wire };
  } catch (error) {
    return { error: error as { kind: string; outputDiagnostic: unknown }, calls, wire };
  }
}
function assertClosedSchema(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(assertClosedSchema);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  expect(node).not.toHaveProperty('oneOf');
  expect(node).not.toHaveProperty('default');
  expect(node).not.toHaveProperty('$schema');
  if (node.type === 'object') {
    expect(node.additionalProperties).toBe(false);
    expect(node.required).toEqual(Object.keys(node.properties as object));
  }
  Object.values(node).forEach(assertClosedSchema);
}

function completeMcq() {
  return parseProviderBankIr(JSON.stringify(bank)).difficulties.easy[0]!;
}
function completeFree() {
  return parseProviderBankIr(JSON.stringify(bank)).difficulties.medium[0]!;
}

describe('OpenAI strict generation prototype, without provider calls', () => {
  it('sends a closed nested-anyOf schema derived from canonical BankIR, omitting trusted metadata', async () => {
    const got = await generate(JSON.stringify(bank));
    expect(got.calls).toBe(1);
    expect(got.error).toBeUndefined();
    expect(got.result).toEqual(bank);
    expect(got.wire.response_format).toEqual(openAiBankIrResponseFormat('demo'));
    expect(JSON.stringify(got.wire)).not.toContain('fixture-never-sent');
    const schema = openAiBankIrResponseFormat('demo').json_schema.schema as { properties: object };
    expect(Object.keys(schema.properties)).toEqual(['version', 'subject', 'difficulties']);
    assertClosedSchema(schema);
    expect(JSON.stringify(schema)).toContain('anyOf');
    expect(JSON.stringify(schema).length).toBeLessThan(12000);
  });
  it.each(['demo', 'cell-biology-2'])(
    'constrains all six ID variants to subject %s and preserves key mapping',
    async (subjectId) => {
      const format = openAiBankIrResponseFormat(subjectId);
      const schema = format.json_schema.schema as {
        properties: {
          subject: { properties: { id: { enum: string[] } } };
          difficulties: {
            properties: Record<
              string,
              {
                items: {
                  anyOf: {
                    properties: { id: { pattern: string }; type: { enum: string[] } };
                  }[];
                };
              }
            >;
          };
        };
      };
      expect(schema.properties.subject.properties.id.enum).toEqual([subjectId]);
      assertClosedSchema(schema);
      const complete = parseProviderBankIr(JSON.stringify(bank));
      complete.subject.id = subjectId;
      for (const difficulty of DIFFICULTIES) {
        complete.difficulties[difficulty] = [];
        const variants = schema.properties.difficulties.properties[difficulty]!.items.anyOf;
        for (const type of ['mcq', 'free'] as const) {
          const variant = variants.find((item) => item.properties.type.enum[0] === type)!;
          const pattern = new RegExp(variant.properties.id.pattern);
          const suffix = type === 'free' ? '-free' : '';
          const id = `${subjectId}-${difficulty}${suffix}-1`;
          expect(pattern.test(id)).toBe(true);
          expect(pattern.test(`${subjectId}-${difficulty}${suffix}-42`)).toBe(true);
          expect(pattern.test(`other-${difficulty}${suffix}-1`)).toBe(false);
          expect(pattern.test(`${subjectId}-${difficulty}${suffix}-one`)).toBe(false);
          expect(pattern.test(`${subjectId}-${difficulty}${suffix}-1-trailing`)).toBe(false);
          const otherType = type === 'free' ? '' : '-free';
          expect(pattern.test(`${subjectId}-${difficulty}${otherType}-1`)).toBe(false);
          for (const otherDifficulty of DIFFICULTIES.filter((value) => value !== difficulty)) {
            expect(pattern.test(`${subjectId}-${otherDifficulty}${suffix}-1`)).toBe(false);
          }
          complete.difficulties[difficulty].push({
            ...structuredClone(type === 'mcq' ? completeMcq() : completeFree()),
            id,
          });
        }
      }
      let calls = 0;
      const result = await openaiProvider.generate(
        { ...request, subject: complete.subject },
        {
          env: { OPENAI_API_KEY: 'fixture' },
          fetch: async (_url, init) => {
            calls++;
            expect(JSON.parse(String(init?.body)).response_format).toEqual(format);
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: 'stop',
                    message: {
                      content: JSON.stringify(complete),
                    },
                  },
                ],
              }),
            );
          },
        },
      );
      expect(calls).toBe(1);
      expect(validateIrCollection([{ path: 'fixture', data: result }]).ok).toBe(true);
      const split = splitIr(result);
      for (const difficulty of DIFFICULTIES) {
        for (const item of result.difficulties[difficulty]) {
          expect(
            split.questions[difficulty].find((question) => question.id === item.id)?.type,
          ).toBe(item.type);
          expect(split.keys[item.id]?.type).toBe(item.type);
        }
      }
      expect(Object.keys(split.keys)).toHaveLength(6);
      // Pattern compliance cannot prove uniqueness; keep this separate semantic gate.
      result.difficulties.hard.push(structuredClone(result.difficulties.hard[0]!));
      expect(validateIrCollection([{ path: 'fixture', data: result }]).ok).toBe(false);
      expect(semanticOutputDiagnostic(result).fields).toContainEqual({
        path: 'difficulties.hard.[].id',
        code: 'duplicate_id',
      });
    },
  );
  it('builds independent schemas for consecutive subjects without mutating previous output', () => {
    const first = openAiBankIrResponseFormat('first');
    const saved = JSON.stringify(first);
    expect(JSON.stringify(openAiBankIrResponseFormat('second'))).not.toContain('first-');
    expect(JSON.stringify(first)).toBe(saved);
  });
  it.each(['length', 'content_filter', 'tool_calls', 'unexpected'])(
    'rejects %s even when content parses, without retrying',
    async (reason) => {
      const got = await generate(JSON.stringify(bank), reason);
      expect(got.calls).toBe(1);
      expect(got.error).toMatchObject({
        kind: 'output',
        outputDiagnostic: { category: 'incomplete', fields: [] },
      });
    },
  );
  it('rejects refusal text without copying it to diagnostics', async () => {
    const got = await generate(JSON.stringify(bank), 'stop', 'private refusal sk-sensitive');
    expect(got.error).toMatchObject({ outputDiagnostic: { category: 'refusal', fields: [] } });
    expect(JSON.stringify(got.error?.outputDiagnostic)).not.toContain('private');
    expect(got.calls).toBe(1);
  });
  it.each(['', null, { arbitrary: 'private' }])(
    'rejects missing or non-string content safely',
    async (value) => {
      expect((await generate(value)).error).toMatchObject({
        outputDiagnostic: { category: 'empty', fields: [] },
      });
    },
  );
  it('rejects fenced/trailing-prose output in strict OpenAI mode but preserves legacy parser behavior', async () => {
    const fenced = '```json\n' + JSON.stringify(bank) + '\n```';
    expect((await generate(fenced)).error).toMatchObject({
      outputDiagnostic: { category: 'json' },
    });
    expect(parseProviderBankIr(fenced)).toEqual(bank);
  });
  it('captures missing provenance using only static field paths and codes', async () => {
    const malformed = structuredClone(bank);
    Reflect.deleteProperty(malformed.difficulties.easy[0]!, 'provenance');
    const got = await generate(JSON.stringify(malformed));
    expect(got.error).toMatchObject({
      outputDiagnostic: {
        category: 'schema',
        fields: [{ path: 'difficulties.easy.[].provenance', code: 'invalid_type' }],
      },
    });
  });
  it('never includes attacker-controlled property names or field values in diagnostics', async () => {
    const malformed = { ...bank, 'sk-private-unknown-field': 'private answer' };
    const got = await generate(JSON.stringify(malformed));
    expect(got.error).toMatchObject({
      outputDiagnostic: {
        category: 'schema',
        fields: [{ path: 'root', code: 'unrecognized_keys' }],
      },
    });
    expect(JSON.stringify(got.error?.outputDiagnostic)).not.toMatch(/sk-private|private answer/);
    expect(inspect(got.error)).not.toMatch(/sk-private|private answer/);
  });
  it('keeps duplicate-ID and wrong-pattern rejection in the authoritative semantic validator', () => {
    const duplicate = parseProviderBankIr(JSON.stringify(bank));
    duplicate.difficulties.easy.push(structuredClone(duplicate.difficulties.easy[0]!));
    expect(validateIrCollection([{ path: 'fixture', data: duplicate }]).ok).toBe(false);
    expect(semanticOutputDiagnostic(duplicate)).toEqual({
      category: 'semantic',
      fields: [{ path: 'difficulties.easy.[].id', code: 'duplicate_id' }],
    });
    duplicate.difficulties.easy[0]!.id = 'private-attacker-id';
    const diagnostic = semanticOutputDiagnostic(duplicate);
    expect(diagnostic.fields[0]).toEqual({ path: 'difficulties.easy.[].id', code: 'id_pattern' });
    expect(JSON.stringify(diagnostic)).not.toContain('private-attacker-id');
  });
  it.each([
    [
      'missing provenance',
      (x: typeof bank): unknown => Reflect.deleteProperty(x.difficulties.easy[0]!, 'provenance'),
    ],
    ['three choices', (x: typeof bank): unknown => x.difficulties.easy[0]!.choices.pop()],
    ['out-of-range answer', (x: typeof bank): unknown => (x.difficulties.easy[0]!.answer = 4)],
    [
      'empty provenance',
      (x: typeof bank): unknown => (x.difficulties.easy[0]!.provenance.locator = ''),
    ],
    [
      'non-positive maxScore',
      (x: typeof bank): unknown => (x.difficulties.medium[0]!.maxScore = 0),
    ],
    ['wrong version', (x: typeof bank): unknown => (x.version = 2)],
  ] as const)(
    'still rejects %s after a mocked schema-compliant envelope',
    async (_name, mutate) => {
      const malformed = structuredClone(bank);
      mutate(malformed);
      const got = await generate(JSON.stringify(malformed));
      expect(got.error).toMatchObject({ kind: 'output', outputDiagnostic: { category: 'schema' } });
      expect(got.calls).toBe(1);
    },
  );
  it.each([
    null,
    {},
    { choices: [] },
    { choices: { 0: { finish_reason: 'stop', message: { content: JSON.stringify(bank) } } } },
    { choices: [{ message: { content: JSON.stringify(bank) } }] },
  ])('rejects malformed or missing completion envelopes without retry', async (envelope) => {
    let calls = 0;
    await expect(
      openaiProvider.generate(request, {
        env: { OPENAI_API_KEY: 'fixture' },
        fetch: async () => {
          calls++;
          return new Response(JSON.stringify(envelope), { status: 200 });
        },
      }),
    ).rejects.toMatchObject({ kind: 'output', outputDiagnostic: { category: 'incomplete' } });
    expect(calls).toBe(1);
  });
  it('hides dynamic source-hash keys even when the key resembles a schema field', async () => {
    const malformed = { ...bank, meta: { sourceHashes: { answer: 42 } } };
    const got = await generate(JSON.stringify(malformed));
    expect(got.error).toMatchObject({
      outputDiagnostic: {
        category: 'schema',
        fields: [{ path: 'meta.sourceHashes', code: 'invalid_type' }],
      },
    });
    expect(inspect(got.error)).not.toContain('42');
  });
  it('does not retain a JSON parser cause that could quote private text', async () => {
    const got = await generate('{"sk-private-canary": definitely-not-JSON}');
    expect(got.error).toMatchObject({ outputDiagnostic: { category: 'json' } });
    expect(inspect(got.error)).not.toContain('sk-private-canary');
    expect(got.error).not.toHaveProperty('cause');
  });
  it('caps structural and semantic diagnostics at six fields', async () => {
    const malformed = structuredClone(bank);
    malformed.difficulties.easy[0]!.q = '';
    malformed.difficulties.easy[0]!.choices = ['', '', '', ''];
    malformed.difficulties.easy[0]!.provenance = { pdf: '', locator: '' };
    const got = await generate(JSON.stringify(malformed));
    expect((got.error?.outputDiagnostic as { fields: unknown[] }).fields).toHaveLength(6);
    const duplicates = parseProviderBankIr(JSON.stringify(bank));
    duplicates.difficulties.easy = Array.from({ length: 20 }, () =>
      structuredClone(duplicates.difficulties.easy[0]!),
    );
    expect(semanticOutputDiagnostic(duplicates).fields).toHaveLength(6);
  });
  it('preserves schema-keyword-like property names and refuses non-disjoint variants', () => {
    const converted = strictWireSchema({
      type: 'object',
      properties: {
        default: { type: 'string' },
        const: { type: 'string' },
        oneOf: { type: 'string' },
      },
      required: ['default', 'const', 'oneOf'],
      additionalProperties: false,
    }) as { properties: object };
    expect(Object.keys(converted.properties)).toEqual(['default', 'const', 'oneOf']);
    expect(() => strictWireSchema({ oneOf: [{ type: 'string' }, { type: 'string' }] })).toThrow(
      'disjoint',
    );
    expect(() =>
      strictWireSchema({
        oneOf: [
          { properties: { type: { const: 'mcq' } } },
          { properties: { type: { const: 'mcq' } } },
        ],
      }),
    ).toThrow('disjoint');
  });
  it('does not downgrade schema or retry when an unsupported model returns 400', async () => {
    let calls = 0;
    await expect(
      openaiProvider.generate(request, {
        env: { OPENAI_API_KEY: 'fixture' },
        fetch: async () => {
          calls++;
          return new Response('{}', { status: 400 });
        },
      }),
    ).rejects.toMatchObject({ kind: 'http', status: 400 });
    expect(calls).toBe(1);
  });
});
