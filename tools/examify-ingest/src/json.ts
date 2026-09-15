/** Pull the first JSON object out of model text (fenced or trailing prose). */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('provider output is not a JSON object');
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`provider output is not valid JSON: ${message}`);
  }
}
