// A fixed product warning only. Raw logs, messages, values and subject IDs are
// never copied. The writer receives newly constructed enum-only data.
const categories = new Set(['json', 'schema', 'semantic', 'refusal', 'incomplete', 'empty']);
const codes = new Set(['invalid_type', 'invalid_value', 'too_small', 'too_big', 'invalid_format', 'invalid_union', 'unrecognized_keys', 'not_multiple_of', 'custom', 'invalid', 'id_pattern', 'duplicate_id']);
const paths = new Set(['root', 'version', 'subject', 'difficulties', 'meta', 'meta.promptVersion', 'meta.provider', 'meta.seed', 'meta.sourceHashes']);
for (const field of ['id', 'label', 'icon', 'l', 'c', 'h']) paths.add(`subject.${field}`);
for (const difficulty of ['easy', 'medium', 'hard']) {
  const base = `difficulties.${difficulty}`;
  paths.add(base); paths.add(`${base}.[]`);
  for (const field of ['id', 'type', 'q', 'choices', 'choices.[]', 'answer', 'rubric', 'maxScore', 'provenance', 'provenance.pdf', 'provenance.locator']) paths.add(`${base}.[].${field}`);
}
function dataObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.keys(descriptors).every(k => keys.includes(k) && 'value' in descriptors[k]);
}
export function safeGenerationDiagnostic(value) {
  if (!dataObject(value, ['category', 'fields']) || !categories.has(value.category) || !Array.isArray(value.fields) || value.fields.length > 6) return null;
  const fields = [];
  const arrayDescriptors = Object.getOwnPropertyDescriptors(value.fields);
  if (Object.values(arrayDescriptors).some(d => !('value' in d))) return null;
  for (let index = 0; index < value.fields.length; index++) {
    const field = arrayDescriptors[String(index)]?.value;
    if (!dataObject(field, ['path', 'code']) || !paths.has(field.path) || !codes.has(field.code)) return null;
    fields.push({ path: field.path, code: field.code });
  }
  return { category: value.category, fields };
}
export function captureGenerationWarning(args, write) {
  if (args.length !== 2 || args[0] !== '[onboarding] generate failed') return;
  const details = args[1];
  if (!dataObject(details, ['reason', 'outputDiagnostic', 'subjectId', 'status']) || details.reason !== 'provider_output_invalid') return;
  let candidate = details.outputDiagnostic;
  if (typeof candidate === 'string') {
    if (Buffer.byteLength(candidate) > 4096) return;
    try { candidate = JSON.parse(candidate); } catch { return; }
  }
  const diagnostic = safeGenerationDiagnostic(candidate);
  if (diagnostic) write(diagnostic);
}
