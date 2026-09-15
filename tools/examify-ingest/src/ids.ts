/** Flatten public question ids from a subject → difficulty bank. */
export function collectQuestionIds(
  bank: Record<string, Partial<Record<string, readonly { id: string }[] | undefined>> | undefined>,
): string[] {
  const ids: string[] = [];
  for (const byDiff of Object.values(bank)) {
    for (const list of Object.values(byDiff ?? {})) {
      for (const question of list ?? []) ids.push(question.id);
    }
  }
  return ids;
}
