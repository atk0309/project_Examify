// Demo harness only. No secrets, network, or application imports in this module.
import { createHash } from 'node:crypto';
// Exact reviewed product BankIR response format. Any schema/feature change fails closed.
const BANK_IR_FORMAT_SHA256 = '7ec651d9c5dfbb30e287fb9aa29ea7104d437fde5d53451d036eb7b77fe54c09';
export const LIMITS = Object.freeze({ calls: 8, bodyBytes: 32768, outputTokens: 8192 });
export const TARGETS = Object.freeze({
  'https://api.openai.com/v1/chat/completions': {
    provider: 'openai',
    model: 'gpt-4o',
    inputUsd: 2.5,
    outputUsd: 10,
  },
  'https://api.anthropic.com/v1/messages': {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    inputUsd: 3,
    outputUsd: 15,
  },
});
export function boundedRequest(url, init) {
  const target = TARGETS[url];
  if (!target || init?.method !== 'POST' || typeof init.body !== 'string')
    throw Error('demo_request_refused');
  if (Buffer.byteLength(init.body) > LIMITS.bodyBytes) throw Error('demo_input_limit');
  const body = JSON.parse(init.body);
  const fields =
    target.provider === 'openai'
      ? ['model', 'temperature', 'seed', 'response_format', 'messages', 'max_tokens']
      : ['model', 'temperature', 'system', 'messages', 'max_tokens'];
  if (Object.keys(body).some((k) => !fields.includes(k))) throw Error('demo_unapproved_feature');
  if (body.model !== target.model || !Array.isArray(body.messages) || body.messages.length > 8)
    throw Error('demo_model_or_message_limit');
  if (body.system !== undefined && typeof body.system !== 'string')
    throw Error('demo_nontext_system');
  if (body.response_format !== undefined) {
    const format = body.response_format;
    const plainJson = format?.type === 'json_object' && Object.keys(format).length === 1;
    const exactBankIr = target.provider === 'openai' &&
      createHash('sha256').update(JSON.stringify(format)).digest('hex') === BANK_IR_FORMAT_SHA256;
    if (!plainJson && !exactBankIr) throw Error('demo_response_format');
  }
  for (const message of body.messages) {
    if (!message || Object.keys(message).some((k) => !['role', 'content'].includes(k)))
      throw Error('demo_message_fields');
    if (!['system', 'user', 'assistant'].includes(message.role)) throw Error('demo_message_role');
    if (typeof message.content === 'string') continue;
    if (
      !Array.isArray(message.content) ||
      message.content.some(
        (block) =>
          block.type !== 'text' ||
          typeof block.text !== 'string' ||
          Object.keys(block).some((k) => !['type', 'text'].includes(k)),
      )
    )
      throw Error('demo_nontext_content');
  }
  const requested = body.max_tokens ?? LIMITS.outputTokens;
  if (!Number.isSafeInteger(requested) || requested < 1) throw Error('demo_bad_output_limit');
  body.max_tokens = Math.min(requested, LIMITS.outputTokens);
  const bounded = JSON.stringify(body);
  if (Buffer.byteLength(bounded) > LIMITS.bodyBytes) throw Error('demo_input_limit');
  return { provider: target.provider, body: bounded };
}
export function worstCaseUsd(provider) {
  const target = Object.values(TARGETS).find((t) => t.provider === provider);
  // Deliberately loose text token allowance: twice every JSON byte, plus framing.
  return (
    LIMITS.calls *
    (((2 * LIMITS.bodyBytes + 1024) * target.inputUsd + LIMITS.outputTokens * target.outputUsd) /
      1e6)
  );
}
