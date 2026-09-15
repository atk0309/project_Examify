/** Pull the first JSON object out of model text (fenced or trailing prose). */
export function extractJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1] ?? '');
  const candidates = [...fenced, text];
  for (const candidate of candidates) {
    for (const slice of scanJsonObjects(candidate)) {
      try {
        const parsed = JSON.parse(slice) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // Try the next balanced object or fenced block.
      }
    }
  }
  throw new Error('provider output is not a JSON object');
}

/** String-aware, brace-balanced object slices in encounter order. */
export function scanJsonObjects(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      i += 1;
      continue;
    }
    const end = endOfJsonObject(text, i);
    if (end === -1) {
      i += 1;
      continue;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

function endOfJsonObject(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
