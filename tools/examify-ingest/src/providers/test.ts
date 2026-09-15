import { bankIrSchema, type BankIR } from '../schema';
import type { GenerateProvider, ProviderRequest } from './types';

/** Deterministic fixture provider. No network. Same seed + sources → same IR. */
export function buildTestBank(request: ProviderRequest): BankIR {
  const fingerprint = request.sources
    .map((source) => source.sha256)
    .join('')
    .slice(0, 16);
  const firstSource = request.sources[0]?.relPath.split('/').pop() ?? 'fixture';
  const id = request.subject.id;
  const bank: BankIR = {
    version: 1,
    subject: { ...request.subject },
    difficulties: {
      easy: [
        {
          id: `${id}-easy-1`,
          type: 'mcq',
          q: `Fixture (${id}, seed ${request.seed}, src ${fingerprint}): what is 2 + 2?`,
          choices: ['3', '4', '5', '22'],
          answer: 1,
          provenance: { pdf: firstSource, locator: `test provider · seed ${request.seed}` },
        },
        {
          id: `${id}-easy-free-1`,
          type: 'free',
          q: `In one sentence, state the fixture fingerprint ${fingerprint}.`,
          rubric:
            'Award up to 2 marks. 1 mark: mentions the fingerprint. 1 mark: a complete sentence. Accept equivalent wording. Do not penalise minor spelling slips; note them separately.',
          maxScore: 2,
          provenance: { pdf: firstSource, locator: `test provider · seed ${request.seed}` },
        },
      ],
      medium: [],
      hard: [],
    },
    meta: {
      promptVersion: request.promptVersion,
      provider: 'test',
      seed: request.seed,
    },
  };
  return bankIrSchema.parse(bank);
}

export const testProvider: GenerateProvider = {
  id: 'test',
  defaultModel: 'fixture-v1',
  keyEnv: null,
  requireReady: () => undefined,
  generate: (request) => Promise.resolve(buildTestBank(request)),
};
