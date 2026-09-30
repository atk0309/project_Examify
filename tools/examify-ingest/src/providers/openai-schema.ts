import { z } from 'zod';
import { bankIrSchema } from '../schema';

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

/** Strict schema constrains shape; the original Zod and ID validators still run afterwards. */
export const OPENAI_BANK_IR_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'examify_bank_ir_v1',
    strict: true,
    schema: strictWireSchema(z.toJSONSchema(bankIrSchema.omit({ meta: true }))),
  },
} as const;
