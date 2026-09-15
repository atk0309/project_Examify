import { z } from 'zod';

export const SUBJECT_ID_RE = /^[a-z][a-z0-9-]*$/;
export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type DifficultyId = (typeof DIFFICULTIES)[number];

const provenanceSchema = z.object({
  pdf: z.string().min(1),
  locator: z.string().min(1),
});

const mcqItemSchema = z.object({
  id: z.string().min(1),
  type: z.literal('mcq'),
  q: z.string().min(1),
  choices: z.array(z.string().min(1)).length(4),
  answer: z.number().int().min(0).max(3),
  provenance: provenanceSchema,
});

const freeItemSchema = z.object({
  id: z.string().min(1),
  type: z.literal('free'),
  q: z.string().min(1),
  rubric: z.string().min(1),
  maxScore: z.number().positive(),
  provenance: provenanceSchema,
});

export const bankItemSchema = z.discriminatedUnion('type', [mcqItemSchema, freeItemSchema]);

export const subjectSchema = z.object({
  id: z.string().regex(SUBJECT_ID_RE, 'subject.id must be kebab-case (^[a-z][a-z0-9-]*$)'),
  label: z.string().min(1),
  icon: z.string().min(1),
  l: z.number(),
  c: z.number(),
  h: z.number(),
});

export const GENERATE_PROVIDERS = ['anthropic', 'openai', 'local', 'test'] as const;
export type GenerateProviderId = (typeof GENERATE_PROVIDERS)[number];

export const DEFAULT_GENERATE_SEED = 0;
export const GENERATE_TEMPERATURE = 0;
export const PROMPT_VERSION = 'v2';
export const INGEST_STATE_DIR = '.examify-ingest';

export const bankIrMetaSchema = z
  .object({
    promptVersion: z.string().optional(),
    provider: z.string().optional(),
    seed: z.union([z.string(), z.number()]).optional(),
    sourceHashes: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** Per-subject generate run record. Never stores API key values. */
export const runManifestSchema = z
  .object({
    provider: z.enum(GENERATE_PROVIDERS),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    promptHash: z.string().min(1),
    seed: z.number().int(),
    temperature: z.literal(0),
    sourceHashes: z.record(z.string(), z.string()),
    cacheKey: z.string().min(1),
    timestamp: z.string().min(1),
    subjectIds: z.array(z.string().min(1)).min(1),
    cacheHit: z.boolean(),
    hasApiKey: z.boolean(),
    keyEnv: z.string().nullable(),
    /** False when the provider API has no seed field (Anthropic Messages). */
    seedHonored: z.boolean(),
  })
  .strict();

export type RunManifest = z.infer<typeof runManifestSchema>;

export const bankIrSchema = z
  .object({
    version: z.literal(1),
    subject: subjectSchema,
    difficulties: z.object({
      easy: z.array(bankItemSchema).default([]),
      medium: z.array(bankItemSchema).default([]),
      hard: z.array(bankItemSchema).default([]),
    }),
    meta: bankIrMetaSchema.optional(),
  })
  .strict();

export type Provenance = z.infer<typeof provenanceSchema>;
export type McqIrItem = z.infer<typeof mcqItemSchema>;
export type FreeIrItem = z.infer<typeof freeItemSchema>;
export type BankIrItem = z.infer<typeof bankItemSchema>;
export type BankIrSubject = z.infer<typeof subjectSchema>;
export type BankIR = z.infer<typeof bankIrSchema>;

export type PublicMcqQuestion = { id: string; type: 'mcq'; q: string; choices: string[] };
export type PublicFreeQuestion = { id: string; type: 'free'; q: string };
export type PublicQuestion = PublicMcqQuestion | PublicFreeQuestion;
export type PublicQuestionBank = Partial<Record<DifficultyId, PublicQuestion[]>>;

export type McqKey = { type: 'mcq'; answer: number; provenance: Provenance };
export type FreeKey = { type: 'free'; rubric: string; maxScore: number; provenance: Provenance };
export type AnswerKey = McqKey | FreeKey;

export type SplitIr = {
  subject: BankIrSubject;
  questions: Record<DifficultyId, PublicQuestion[]>;
  keys: Record<string, AnswerKey>;
};
