export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Skip the O(n×m) table when a dry-run diff would allocate more than this many cells. */
export const MAX_DIFF_CELLS = 1_000_000;

function lineDiff(before: string, after: string): string[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  // Drop the trailing empty line that JSON.stringify + '\n' produces on both sides
  // so hunks stay aligned with visible content.
  if (a.at(-1) === '') a.pop();
  if (b.at(-1) === '') b.pop();

  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? (dp[i + 1]![j + 1] ?? 0) + 1
          : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      lines.push(`-${a[i]}`);
      i += 1;
    } else {
      lines.push(`+${b[j]}`);
      j += 1;
    }
  }
  while (i < n) {
    lines.push(`-${a[i]}`);
    i += 1;
  }
  while (j < m) {
    lines.push(`+${b[j]}`);
    j += 1;
  }
  return lines;
}

export function formatFileDiff(relPath: string, existing: string | null, planned: string): string {
  if (existing === null) {
    const body = planned.endsWith('\n') ? planned.slice(0, -1) : planned;
    const added = body.split('\n').map((line) => `+${line}`);
    return [
      `would create ${relPath}`,
      '--- /dev/null',
      `+++ ${relPath}`,
      `@@ -0,0 +1,${added.length} @@`,
      ...added,
    ].join('\n');
  }

  if (existing === planned) {
    return `unchanged ${relPath}`;
  }

  const hunk = lineDiff(existing, planned);
  if (hunk === null) {
    return [
      `would update ${relPath}`,
      `--- ${relPath} (on disk)`,
      `+++ ${relPath} (planned)`,
      '(detailed diff omitted; file too large)',
    ].join('\n');
  }
  return [
    `would update ${relPath}`,
    `--- ${relPath} (on disk)`,
    `+++ ${relPath} (planned)`,
    ...hunk,
  ].join('\n');
}
