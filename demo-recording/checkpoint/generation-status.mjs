// Only fixed UI copy is exported. Never copy an arbitrary error, provider body,
// request headers, environment values, or answer keys into evidence.
const failures = new Map([
  ['The AI replied, but not with questions Examify can use. Try Generate again. Nothing was written.', 'provider_output_invalid'],
  ['Generate failed and nothing was written. Try again, or run the generate command under Power-user commands on the host to see the full error.', 'generate_failed'],
  ['Could not reach the AI provider, or it is busy right now. Check this host’s network and try again in a few minutes. Nothing was written.', 'provider_unavailable'],
  ['Something went wrong.', 'unexpected_failure'],
]);
export function classifyGenerationError(text) {
  return failures.get(text?.trim()) ?? 'unclassified_failure';
}
