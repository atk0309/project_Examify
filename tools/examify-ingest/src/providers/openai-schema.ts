import { z } from 'zod';
import { bankIrSchema, bankItemSchema, subjectSchema, type DifficultyId } from '../schema';
import { idPattern } from '../validate';

/**
 * Derive the wire contract from BankIR rather than maintaining a second shape.
 * Server-owned meta is not requested. Zod's disjoint `type` variants emit oneOf;
 * OpenAI supports nested anyOf, which is equivalent for these literal variants.
 * Defaults and the dialect marker are not part of the strict API subset.
 */
export function strictWireSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictWireSchema);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      if (key === '$schema' || key === 'default') return [];
      if (key === 'properties' || key === '$defs') {
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(child as Record<string, unknown>).map(([name, schema]) => [
                name,
                strictWireSchema(schema),
              ]),
            ),
          ],
        ];
      }
      if (key === 'oneOf') {
        const variants = child as { properties?: { type?: { const?: unknown } } }[];
        const tags = variants.map((variant) => variant.properties?.type?.const);
        if (tags.some((tag) => typeof tag !== 'string') || new Set(tags).size !== tags.length) {
          throw new Error('BankIR strict schema requires disjoint literal item types');
        }
        return [['anyOf', strictWireSchema(child)]];
      }
      if (key === 'const') return [['enum', [child]]];
      return [[key, strictWireSchema(child)]];
    }),
  );
}

/**
 * Bind IDs to the requested subject, array difficulty and discriminated item type.
 * Cross-item uniqueness cannot be expressed by the supported schema subset;
 * the original semantic validator remains authoritative before any writes.
 */
export function openAiBankIrResponseFormat(subjectId: string) {
  const id = subjectSchema.shape.id.parse(subjectId);
  const items = (difficulty: DifficultyId) =>
    z.array(
      z.discriminatedUnion('type', [
        bankItemSchema.options[0].extend({
          id: z
            .string()
            .min(1)
            .regex(idPattern(id, difficulty, 'mcq')),
        }),
        bankItemSchema.options[1].extend({
          id: z
            .string()
            .min(1)
            .regex(idPattern(id, difficulty, 'free')),
        }),
      ]),
    );
  const schema = bankIrSchema.omit({ meta: true }).extend({
    subject: subjectSchema.extend({ id: z.literal(id) }),
    difficulties: z.object({
      easy: items('easy'),
      medium: items('medium'),
      hard: items('hard'),
    }),
  });
  return {
    type: 'json_schema',
    json_schema: {
      name: 'examify_bank_ir_v1',
      strict: true,
      schema: strictWireSchema(z.toJSONSchema(schema)),
    },
  } as const;
}
