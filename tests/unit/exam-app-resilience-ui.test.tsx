/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { Component, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordAttemptInput, RecordAttemptResult } from '@/actions/recordAttempt';
import type { SaveExamProgressInput } from '@/actions/saveExamProgress';
import type { DifficultyId, Question, QuestionBank, Subject } from '@/lib/exam/data';
import type { ExamMarking } from '@/lib/onboarding-types';

// A stateful stand-in for the `exam_sessions` table with the real contract:
// begin upserts, the autosave is update-only, discard and a marked finish delete.
type Draft = Pick<SaveExamProgressInput, 'questionIds' | 'answers' | 'currentIndex'>;
const drafts = new Map<string, Draft>();
const key = (subject: string, difficulty: string) => `${subject}::${difficulty}`;
// Every action call in order, e.g. "save maths::easy".
const calls: string[] = [];

const defaultRecordAttempt = async (input: RecordAttemptInput): Promise<RecordAttemptResult> => {
  calls.push(`record ${key(input.subject, input.difficulty)}`);
  drafts.delete(key(input.subject, input.difficulty));
  const attempt = {
    id: calls.length,
    subject: input.subject,
    difficulty: input.difficulty as DifficultyId,
    total: input.items.length,
    correct: 0,
    scorePct: 0,
    createdAt: 0,
    items: [],
  };
  return { ok: true, scorePct: 0, attempt, progress: { attempts: [attempt], subjects: [] } };
};
const recordAttempt = vi.fn(defaultRecordAttempt);
const beginExamSession = vi.fn(async (input: SaveExamProgressInput) => {
  calls.push(`begin ${key(input.subject, input.difficulty)}`);
  const { questionIds, answers, currentIndex } = input;
  drafts.set(key(input.subject, input.difficulty), { questionIds, answers, currentIndex });
  return { ok: true as const };
});
const saveExamProgress = vi.fn(async (input: SaveExamProgressInput) => {
  calls.push(`save ${key(input.subject, input.difficulty)}`);
  const k = key(input.subject, input.difficulty);
  const { questionIds, answers, currentIndex } = input;
  if (drafts.has(k)) drafts.set(k, { questionIds, answers, currentIndex });
  return { ok: true as const };
});
const discardExamSession = vi.fn(async (input: { subject: string; difficulty: string }) => {
  calls.push(`discard ${key(input.subject, input.difficulty)}`);
  drafts.delete(key(input.subject, input.difficulty));
  return { ok: true as const };
});
const setStudentMode = vi.fn(async (on: boolean) => {
  calls.push(`studentMode ${on}`);
  return { ok: true as const };
});

vi.mock('@/actions/recordAttempt', () => ({
  recordAttempt: (input: RecordAttemptInput) => recordAttempt(input),
}));
vi.mock('@/actions/saveExamProgress', () => ({
  beginExamSession: (input: SaveExamProgressInput) => beginExamSession(input),
  saveExamProgress: (input: SaveExamProgressInput) => saveExamProgress(input),
}));
vi.mock('@/actions/discardExamSession', () => ({
  discardExamSession: (input: { subject: string; difficulty: string }) => discardExamSession(input),
}));
vi.mock('@/actions/toggleStudentMode', () => ({
  setStudentMode: (on: boolean) => setStudentMode(on),
}));
vi.mock('@/actions/signOut', () => ({ signOut: vi.fn() }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { redirect } from 'next/navigation';
import { ExamApp, type Resumable } from '@/components/exam/ExamApp';

const subjects: Subject[] = [
  { id: 'maths', label: 'Maths', icon: 'maths', l: 0.6, c: 0.1, h: 200 },
  { id: 'geo', label: 'Geography', icon: 'geography', l: 0.6, c: 0.1, h: 100 },
];
const mcq = (id: string): Question => ({
  id,
  type: 'mcq',
  q: `Question ${id}`,
  choices: ['a', 'b', 'c'],
});
const free = (id: string): Question => ({ id, type: 'free', q: `Explain ${id}` });
const bank: QuestionBank = {
  maths: { easy: [mcq('m1'), mcq('m2'), mcq('m3')] },
  geo: { easy: [mcq('g1'), free('g2')] },
};
const empty = { attempts: [], subjects: [] };

/** Stands in for Next's error page: anything thrown out of ExamApp lands here. */
class Crashed extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    return this.state.error ? <p data-testid="crashed">crashed</p> : this.props.children;
  }
}

const marked: ExamMarking = { written: 'marked', by: 'Anthropic' };

function renderApp(
  props: {
    resumable?: Resumable[];
    role?: 'student' | 'parent';
    marking?: ExamMarking;
    subjects?: Subject[];
    questionBank?: QuestionBank;
  } = {},
) {
  const role = props.role ?? 'student';
  return render(
    <Crashed>
      <ExamApp
        role={role}
        studentMode={role === 'parent'}
        initialProgress={empty}
        subjects={props.subjects ?? subjects}
        questionBank={props.questionBank ?? bank}
        resumable={props.resumable ?? []}
        marking={props.marking ?? marked}
      />
    </Crashed>,
  );
}

/** Let pending action promises settle (and optionally real timers run). */
const settle = async (ms = 0) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};
const progress = () => screen.getByTestId('exam-progress').textContent;
const choices = () => screen.getAllByTestId('exam-choice');
const clickNext = () => fireEvent.click(screen.getByTestId('exam-next'));
const goHome = () =>
  fireEvent.click(screen.getAllByRole('button', { name: 'Back to subjects' })[0]!);

async function startExam(subjectId: string) {
  fireEvent.click(screen.getByTestId(`subject-card-${subjectId}`));
  fireEvent.click(screen.getByTestId('difficulty-easy'));
  fireEvent.click(screen.getByTestId('start-exam'));
  await settle();
}

/** Answer whatever is on screen: text for free-text, else the given choice. */
function answer(text = 'Rivers carve valleys over time.', choice = 0) {
  const box = screen.queryByTestId('exam-free-answer');
  if (box) fireEvent.change(box, { target: { value: text } });
  else fireEvent.click(choices()[choice]!);
}

beforeEach(() => {
  drafts.clear();
  calls.length = 0;
  vi.clearAllMocks();
  // Keep papers in bank order (buildExam shuffles): geo is MCQ then free-text.
  vi.spyOn(Math, 'random').mockReturnValue(0.999);
  // React logs what an error boundary catches; the crash cases assert it instead.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExamApp marking screen', () => {
  it('says written answers can take up to a minute, only when the paper has one', async () => {
    // Finishing waits on a submit the test releases (React holds later async
    // transitions while one is pending, so every one is released before the end).
    const held: (() => void)[] = [];
    recordAttempt.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          const attempt = {
            id: held.length + 1,
            subject: input.subject,
            difficulty: input.difficulty as DifficultyId,
            total: input.items.length,
            correct: 0,
            scorePct: 0,
            createdAt: 0,
            items: [],
          };
          held.push(() =>
            resolve({
              ok: true,
              scorePct: 0,
              attempt,
              progress: { attempts: [attempt], subjects: [] },
            }),
          );
        }),
    );
    try {
      renderApp();
      await startExam('geo');
      answer();
      clickNext();
      await settle();
      answer();
      clickNext(); // Finish: geo has a written answer
      await settle();
      expect(screen.getByText('Marking your answers…')).toBeInTheDocument();
      expect(screen.getByTestId('marking-written-note')).toHaveTextContent(
        'Written answers can take up to a minute to mark.',
      );
      held.shift()?.();
      await settle();
      cleanup();

      renderApp();
      await startExam('maths');
      for (let i = 0; i < 3; i += 1) {
        answer();
        clickNext();
        await settle();
      }
      expect(screen.getByText('Marking your answers…')).toBeInTheDocument();
      expect(screen.queryByTestId('marking-written-note')).toBeNull();
    } finally {
      while (held.length > 0) held.shift()?.();
      await settle();
      recordAttempt.mockImplementation(defaultRecordAttempt);
    }
  });
});

describe('ExamApp when the server cannot be reached', () => {
  it('keeps the answers after a failed submit and "Try again" marks the same paper', async () => {
    recordAttempt.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderApp();
    await startExam('geo');
    answer();
    clickNext();
    await settle();
    answer();
    clickNext(); // Finish exam
    await settle();

    expect(screen.queryByTestId('crashed')).toBeNull();
    const error = screen.getByTestId('exam-error-unreachable');
    expect(error).toHaveTextContent('your answers are still here');

    fireEvent.click(screen.getByTestId('exam-retry'));
    await settle();

    expect(screen.getByTestId('results-score')).toBeInTheDocument();
    expect(recordAttempt).toHaveBeenCalledTimes(2);
    const [first, second] = recordAttempt.mock.calls.map(([input]) => input);
    expect(second).toEqual(first);
    expect(first!.items).toContainEqual({
      type: 'free',
      id: 'g2',
      response: 'Rivers carve valleys over time.',
    });
  });

  it('offers no retry for a paper the server refuses, and drops its dead-end resume card', async () => {
    recordAttempt.mockResolvedValueOnce({ ok: false, reason: 'invalid' });
    renderApp();
    await startExam('geo');
    answer();
    clickNext();
    await settle();
    answer();
    clickNext();
    await settle();

    const error = screen.getByTestId('exam-error-refused');
    expect(error).toHaveTextContent('start a fresh one');
    expect(screen.queryByTestId('exam-retry')).toBeNull();
    expect(recordAttempt).toHaveBeenCalledTimes(1);

    goHome();
    expect(screen.getByText('Pick a subject to practise.')).toBeInTheDocument();
    expect(screen.queryByTestId('resume-geo-easy')).toBeNull();
  });

  it('lets Next redirects from an action through instead of showing a retry', async () => {
    let redirectError: unknown;
    try {
      redirect('/signin/invalidate');
    } catch (caught) {
      redirectError = caught;
    }
    recordAttempt.mockRejectedValueOnce(redirectError);
    renderApp();
    await startExam('geo');
    answer();
    clickNext();
    await settle();
    answer();
    clickNext();
    await settle();

    expect(screen.getByTestId('crashed')).toBeInTheDocument();
  });

  it('keeps the exam going when an autosave fails, and the next checkpoint sends it all', async () => {
    renderApp();
    await startExam('maths');
    answer(undefined, 1);
    saveExamProgress.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    clickNext();
    await settle();

    expect(screen.queryByTestId('crashed')).toBeNull();
    expect(progress()).toBe('Question 2 of 3');

    answer(undefined, 2);
    clickNext();
    await settle();

    const draft = drafts.get('maths::easy');
    expect(draft?.currentIndex).toBe(2);
    expect(draft?.answers.slice(0, 2)).toEqual([1, 2]);
  });

  it('creates the draft at the next checkpoint when creating it on Start failed', async () => {
    beginExamSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderApp();
    await startExam('maths');

    expect(screen.queryByTestId('crashed')).toBeNull();
    expect(progress()).toBe('Question 1 of 3');
    expect(drafts.has('maths::easy')).toBe(false);

    answer(undefined, 1);
    clickNext();
    await settle();

    // An update-only autosave would have saved nothing: the draft is created now.
    expect(beginExamSession).toHaveBeenCalledTimes(2);
    expect(drafts.get('maths::easy')).toMatchObject({ currentIndex: 1 });
    expect(drafts.get('maths::easy')?.answers[0]).toBe(1);

    // Once it exists, checkpoints go back to the update-only autosave.
    answer(undefined, 0);
    clickNext();
    await settle();
    expect(beginExamSession).toHaveBeenCalledTimes(2);
    expect(saveExamProgress).toHaveBeenCalledTimes(1);
    expect(drafts.get('maths::easy')?.currentIndex).toBe(2);
  });

  it('keeps the dashboard up when discarding a draft fails', async () => {
    discardExamSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderApp();
    await startExam('maths');
    goHome();
    fireEvent.click(screen.getByRole('button', { name: 'Discard your Maths exam' }));
    await settle();

    expect(screen.queryByTestId('crashed')).toBeNull();
    expect(screen.queryByTestId('resume-maths-easy')).toBeNull();
  });
});

describe('ExamApp sends the waiting autosave when the exam is left', () => {
  /** Geography: pick on question 1, then type on question 2 (free-text). */
  async function typeOnQuestionTwo(text: string) {
    await startExam('geo');
    answer(text);
    clickNext();
    await settle();
    answer(text);
  }

  it('on Home, right after typing', async () => {
    renderApp();
    await typeOnQuestionTwo('A long answer typed just now.');
    const before = saveExamProgress.mock.calls.length;
    goHome();
    await settle();

    expect(saveExamProgress).toHaveBeenCalledTimes(before + 1);
    expect(drafts.get('geo::easy')?.answers).toEqual([0, 'A long answer typed just now.']);
    // Sent once — the debounce timer does not fire a second save later.
    await settle(800);
    expect(saveExamProgress).toHaveBeenCalledTimes(before + 1);
  });

  it('when the tab is hidden or closed', async () => {
    renderApp();
    await typeOnQuestionTwo('Typed before switching apps.');
    const before = saveExamProgress.mock.calls.length;
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockRestore();
    await settle();

    expect(saveExamProgress).toHaveBeenCalledTimes(before + 1);
    expect(drafts.get('geo::easy')?.answers).toEqual([0, 'Typed before switching apps.']);

    answer('Typed before closing the tab.');
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(saveExamProgress).toHaveBeenCalledTimes(before + 2);
    expect(drafts.get('geo::easy')?.answers).toEqual([0, 'Typed before closing the tab.']);
  });

  it('when a parent exits student mode, before the switch', async () => {
    renderApp({ role: 'parent' });
    await typeOnQuestionTwo('The parent’s answer.');
    fireEvent.click(screen.getByRole('button', { name: 'Exit student mode' }));
    await settle();

    expect(calls.slice(-2)).toEqual(['save geo::easy', 'studentMode false']);
    expect(drafts.get('geo::easy')?.answers).toEqual([0, 'The parent’s answer.']);
  });

  it('on Finish, ahead of the submit, so nothing can recreate the finished draft', async () => {
    renderApp();
    await typeOnQuestionTwo('Answered and finished at once.');
    clickNext(); // Finish exam
    await settle(800);

    // The typed answer was saved, then the submit cleared the draft — and no
    // save came after it to bring the finished draft back.
    expect(saveExamProgress.mock.lastCall?.[0].answers).toEqual([
      0,
      'Answered and finished at once.',
    ]);
    expect(calls.slice(-2)).toEqual(['save geo::easy', 'record geo::easy']);
    expect(drafts.has('geo::easy')).toBe(false);
    expect(screen.getByTestId('results-score')).toBeInTheDocument();
  });
});

describe('ExamApp resume prefers the newest copy of a draft', () => {
  it('never lets the page-load snapshot overwrite answers given since', async () => {
    // The page loaded with a Maths draft at question 2 (question 1 answered).
    const saved: Draft = {
      questionIds: ['m1', 'm2', 'm3'],
      answers: [0, null, null],
      currentIndex: 1,
    };
    drafts.set('maths::easy', saved);
    renderApp({
      resumable: [
        {
          subject: 'maths',
          difficulty: 'easy',
          questions: bank.maths!.easy!,
          answers: saved.answers,
          currentIndex: saved.currentIndex,
        },
      ],
    });

    fireEvent.click(screen.getByTestId('resume-maths-easy'));
    expect(progress()).toBe('Question 2 of 3');
    answer(undefined, 1);
    clickNext();
    await settle();
    answer(undefined, 2);
    goHome();
    await settle();
    expect(drafts.get('maths::easy')).toEqual({
      questionIds: ['m1', 'm2', 'm3'],
      answers: [0, 1, 2],
      currentIndex: 2,
    });

    // Another exam, then back to the dashboard: Maths is offered once, as left.
    await startExam('geo');
    goHome();
    await settle();
    expect(screen.getAllByTestId('resume-maths-easy')).toHaveLength(1);
    expect(screen.getByTestId('resume-maths-easy')).toHaveTextContent('Question 3 of 3');
    expect(screen.getByTestId('resume-geo-easy')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('resume-maths-easy'));
    expect(progress()).toBe('Question 3 of 3');
    expect(choices()[2]).toHaveClass('selected');
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(choices()[1]).toHaveClass('selected');
    clickNext();
    await settle();

    expect(drafts.get('maths::easy')?.answers).toEqual([0, 1, 2]);
  });

  it('keeps an exam started this session on the resume list after starting another', async () => {
    renderApp();
    await startExam('maths');
    answer(undefined, 2);
    clickNext();
    await settle();
    goHome();
    await startExam('geo');
    goHome();
    await settle();

    expect(screen.getByTestId('resume-maths-easy')).toHaveTextContent('Question 2 of 3');
    fireEvent.click(screen.getByTestId('resume-maths-easy'));
    expect(progress()).toBe('Question 2 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(choices()[2]).toHaveClass('selected');

    // Geography, left for Maths, is still offered too.
    goHome();
    expect(screen.getByTestId('resume-geo-easy')).toBeInTheDocument();
  });
});

describe('ExamApp and what this server can mark', () => {
  const unmarked: ExamMarking = { written: 'unmarked' };
  const openDifficulty = (subjectId: string) => {
    fireEvent.click(screen.getByTestId(`subject-card-${subjectId}`));
    fireEvent.click(screen.getByTestId('difficulty-easy'));
  };

  it('names who marks written answers and keeps them in the paper', async () => {
    renderApp();
    openDifficulty('geo');
    expect(screen.getByTestId('exam-written-line')).toHaveTextContent(
      'Written answers are marked by Anthropic.',
    );
    fireEvent.click(screen.getByTestId('start-exam'));
    await settle();
    expect(progress()).toBe('Question 1 of 2');
    expect(beginExamSession.mock.calls[0]![0].questionIds).toEqual(['g1', 'g2']);
    answer();
    clickNext();
    expect(screen.getByTestId('exam-free-answer')).toBeInTheDocument();
    expect(screen.queryByTestId('exam-free-unmarked')).toBeNull();
  });

  it('says a test mark is given while the test key stands in', () => {
    renderApp({ marking: { written: 'stub' } });
    openDifficulty('geo');
    expect(screen.getByTestId('exam-written-line')).toHaveTextContent(
      'Written answers get a test mark on this server.',
    );
  });

  it('says nothing about written answers for a paper without any', () => {
    renderApp({ marking: unmarked });
    openDifficulty('maths');
    expect(screen.queryByTestId('exam-written-line')).toBeNull();
  });

  it('leaves written questions out when nothing here can mark them, and says so', async () => {
    renderApp({ marking: unmarked });
    openDifficulty('geo');
    expect(screen.getByTestId('exam-written-line')).toHaveTextContent(
      'Written questions are left out: this server can’t mark written answers yet.',
    );
    fireEvent.click(screen.getByTestId('start-exam'));
    await settle();
    expect(progress()).toBe('Question 1 of 1');
    expect(beginExamSession.mock.calls[0]![0].questionIds).toEqual(['g1']);
    answer();
    clickNext(); // Finish
    await settle();
    expect(recordAttempt.mock.calls[0]![0].items).toEqual([{ type: 'mcq', id: 'g1', chosen: 0 }]);
  });

  it('keeps a paper of written questions only, saying under each that it counts as not correct', async () => {
    const essay: Subject = {
      id: 'essay',
      label: 'Essay',
      icon: 'geography',
      l: 0.6,
      c: 0.1,
      h: 40,
    };
    let release = () => {};
    recordAttempt.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          release = () => void defaultRecordAttempt(input).then(resolve);
        }),
    );
    renderApp({
      marking: unmarked,
      subjects: [essay],
      questionBank: { essay: { easy: [free('e1'), free('e2')] } },
    });
    openDifficulty('essay');
    expect(screen.getByTestId('exam-written-line')).toHaveTextContent(
      'This server can’t mark written answers yet, so they count as not correct.',
    );
    fireEvent.click(screen.getByTestId('start-exam'));
    await settle();
    expect(progress()).toBe('Question 1 of 2');
    expect(screen.getByTestId('exam-free-unmarked')).toHaveTextContent(
      'This server can’t mark written answers yet, so they count as not correct.',
    );
    answer();
    clickNext();
    expect(screen.getByTestId('exam-free-unmarked')).toBeInTheDocument();
    answer();
    clickNext(); // Finish
    await settle();
    // Nothing marks them, so no "up to a minute" wait is promised.
    expect(screen.getByText('Marking your answers…')).toBeInTheDocument();
    expect(screen.queryByTestId('marking-written-note')).toBeNull();
    release();
    await settle();
  });

  it('shows the note under a written question of a draft started while marking worked', async () => {
    renderApp({
      marking: unmarked,
      resumable: [
        {
          subject: 'geo',
          difficulty: 'easy',
          questions: [mcq('g1'), free('g2')],
          answers: [0, null],
          currentIndex: 1,
        },
      ],
    });
    fireEvent.click(screen.getByTestId('resume-geo-easy'));
    await settle();
    expect(progress()).toBe('Question 2 of 2');
    expect(screen.getByTestId('exam-free-unmarked')).toBeInTheDocument();
  });
});
