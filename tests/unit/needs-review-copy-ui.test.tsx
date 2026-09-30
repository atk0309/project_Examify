/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgressView } from '@/components/exam/ProgressView';
import { NEEDS_REVIEW_COPY, type AttemptRecord } from '@/lib/exam/attempts';

// Pending answers are excluded from scores; no automatic marking is promised.
const HONEST = NEEDS_REVIEW_COPY;

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
  it('does not promise that anything will mark the answer later', () => {
    expect(NEEDS_REVIEW_COPY).not.toMatch(/shortly|later|will mark|for review/i);
    expect(NEEDS_REVIEW_COPY).toMatch(/excluded from your provisional score/);
  });

  it('ProgressView explains an unmarked answer is excluded from the score', () => {
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
});

const pendingItem: AttemptRecord['items'][number] = {
  type: 'free',
  id: 'pending',
  q: 'Explain.',
  response: 'Answer.',
  maxScore: 2,
  score: null,
  status: 'needs_review',
  verdict: null,
};

describe('pending attempt presentation and recovery', () => {
  it('shows awaiting marking without 0%, and leaves a child dashboard read-only', () => {
    const a = { ...attempt([pendingItem]), canRetryGrading: true };
    render(<ProgressView data={{ attempts: [a], subjects: [] }} emptyHint="Empty" />);
    expect(screen.getByText('Awaiting marking')).toBeInTheDocument();
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry marking' })).toBeNull();
  });

  it('uses the marked denominator and retries only a recoverable own attempt', () => {
    const a = {
      ...attempt([
        {
          type: 'mcq' as const,
          id: 'marked',
          q: 'Choose.',
          choices: ['A', 'B'],
          chosen: 0,
          answer: 0,
        },
        pendingItem,
      ]),
      correct: 1,
      scorePct: 100,
      canRetryGrading: true,
    };
    const retry = vi.fn(async () => {});
    render(
      <ProgressView data={{ attempts: [a], subjects: [] }} emptyHint="Empty" onRetry={retry} />,
    );
    expect(screen.getByText('1/1')).toBeInTheDocument();
    expect(screen.getByText('100% · Provisional')).toBeInTheDocument();
    expect(screen.getByText('1 awaiting marking')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry marking' }));
    expect(retry).toHaveBeenCalledWith(a.id);
  });

  it('does not offer recovery without the original marking snapshot', () => {
    render(
      <ProgressView
        data={{ attempts: [attempt([pendingItem])], subjects: [] }}
        emptyHint="Empty"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Retry marking' })).toBeNull();
  });
});
