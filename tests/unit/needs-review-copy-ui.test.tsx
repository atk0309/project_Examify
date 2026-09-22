/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProgressView } from '@/components/exam/ProgressView';
import type { AttemptRecord } from '@/lib/exam/attempts';

// needs_review is permanent (nothing re-grades it) and counts as not correct,
// so the kid-facing copy must not promise later marking.
const HONEST = 'We couldn’t mark this one automatically, so it counts as not correct.';

afterEach(() => cleanup());

function attempt(items: AttemptRecord['items']): AttemptRecord {
  return {
    id: 1,
    subject: 'maths',
    difficulty: 'easy',
    total: items.length,
    correct: 0,
    scorePct: 0,
    createdAt: Date.UTC(2026, 0, 5),
    items,
  };
}

describe('needs_review copy', () => {
  it('ProgressView says an unmarked answer counts as not correct', () => {
    render(
      <ProgressView
        emptyHint="No attempts yet."
        data={{
          attempts: [
            attempt([
              {
                type: 'free',
                id: 'maths-easy-free-1',
                q: 'Explain what a fraction is.',
                response: 'A part of a whole.',
                maxScore: 2,
                score: null,
                status: 'needs_review',
                verdict: null,
              },
            ]),
          ],
          subjects: [{ subjectId: 'maths', attempts: 1, best: 0, average: 0, last: 0 }],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText(HONEST)).toBeInTheDocument();
    expect(screen.queryByText(/saved for review/i)).toBeNull();
  });

  it('ProgressView still renders a graded verdict, not the unmarked line', () => {
    render(
      <ProgressView
        emptyHint="No attempts yet."
        data={{
          attempts: [
            attempt([
              {
                type: 'free',
                id: 'maths-easy-free-1',
                q: 'Explain what a fraction is.',
                response: 'A part of a whole.',
                maxScore: 2,
                score: 2,
                status: 'graded',
                verdict: {
                  score: 2,
                  verdict: 'Clear and correct.',
                  gotRight: [],
                  toReview: [],
                  spelling: [],
                },
              },
            ]),
          ],
          subjects: [{ subjectId: 'maths', attempts: 1, best: 100, average: 100, last: 100 }],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText(/Clear and correct\./)).toBeInTheDocument();
    expect(screen.queryByText(HONEST)).toBeNull();
  });

  it('ExamApp results never promise that a held answer will be marked later', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/components/exam/ExamApp.tsx'),
      'utf8',
    );
    expect(source).toContain(
      'We couldn&rsquo;t mark this one automatically, so it counts as not correct.',
    );
    expect(source).not.toMatch(/mark this one shortly/);
    expect(source).not.toMatch(/Saved for review/);
  });
});
