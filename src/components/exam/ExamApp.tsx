'use client';

/* ============================================================================
   EXAMIFY — APP  (screens + flow state)
   Flow: dashboard -> difficulty -> exam -> marking -> results
   ----------------------------------------------------------------------------
   Results are SERVER-DRIVEN: the public question bank carries no answer keys
   (those are server-only), so the client cannot self-score. On finish we submit
   the attempt, the server validates + scores + grades free-text, and the
   results render from the returned `AttemptRecord`. A brief "Marking…" state
   covers the round-trip. A submit that never reached the server keeps the
   answers and offers a retry; a paper the server refuses says so instead.
   ========================================================================== */
import { useEffect, useRef, useState, useTransition, type CSSProperties } from 'react';
import { unstable_rethrow, useRouter } from 'next/navigation';
import {
  recordAttempt,
  type RecordAttemptInput,
  type RecordAttemptResult,
} from '@/actions/recordAttempt';
import { beginExamSession, saveExamProgress } from '@/actions/saveExamProgress';
import { discardExamSession } from '@/actions/discardExamSession';
import { setStudentMode } from '@/actions/toggleStudentMode';
import { signOut } from '@/actions/signOut';
import {
  accentCSS,
  buildExam,
  countQuestions,
  DIFFICULTIES,
  difficultiesWithQuestions,
  examPool,
  QUESTIONS,
  SUBJECTS,
  type DifficultyId,
  type Question,
  type QuestionBank,
  type Subject,
} from '@/lib/exam/data';
import {
  isFreePass,
  NEEDS_REVIEW_COPY,
  normalizeAttemptItem,
  type AttemptRecord,
  type ProgressData,
} from '@/lib/exam/attempts';
import type { SessionRole } from '@/lib/auth';
import { EXAM_UNMARKED_WRITTEN, examWrittenLine, type ExamMarking } from '@/lib/onboarding-types';
import { ProgressView } from './ProgressView';
import { SubjectIcon, UIcon } from './icons';

/* ---------------------------------- TopBar ---------------------------------- */
function TopBar({
  onBack,
  onHome,
  label,
}: {
  onBack?: () => void;
  onHome?: () => void;
  label?: string;
}) {
  return (
    <header className="topbar">
      {onBack && (
        <button className="topbar-btn" onClick={onBack} aria-label="Go back">
          {UIcon.back}
        </button>
      )}
      <span className="topbar-spacer" />
      {label && <span className="topbar-label">{label}</span>}
      <span className="topbar-spacer" />
      {onHome && (
        <button className="topbar-btn" onClick={onHome} aria-label="Back to subjects">
          {UIcon.home}
        </button>
      )}
    </header>
  );
}

/* ------------------------------ Presentational ------------------------------ */
function SubjectCard({
  subject,
  sat,
  onClick,
  questionCount,
}: {
  subject: Subject;
  sat: number;
  onClick: () => void;
  questionCount: number;
}) {
  const count = questionCount;
  return (
    <button
      className="subject-card"
      style={accentCSS(subject, sat)}
      onClick={onClick}
      data-testid={`subject-card-${subject.id}`}
    >
      <span className="icon-chip">
        <SubjectIcon name={subject.icon} />
      </span>
      <h3 className="subject-name">{subject.label}</h3>
      <p className="subject-meta">
        <span className="dot" />
        {count} practice questions
      </p>
    </button>
  );
}

function DifficultyCard({
  diff,
  rankClass,
  selected,
  onClick,
}: {
  diff: (typeof DIFFICULTIES)[number];
  rankClass: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={'diff-card' + (selected ? ' selected' : '')}
      onClick={onClick}
      data-testid={`difficulty-${diff.id}`}
    >
      <span className={'diff-rank ' + rankClass}>
        <i />
        <i />
        <i />
      </span>
      <span className="diff-text">
        <h3>{diff.label}</h3>
        <p>{diff.line}</p>
      </span>
      <span className="diff-check">{UIcon.check}</span>
    </button>
  );
}

function Choice({
  label,
  index,
  selected,
  onClick,
}: {
  label: string;
  index: number;
  selected: boolean;
  onClick: () => void;
}) {
  const key = String.fromCharCode(65 + index);
  return (
    <button
      className={'choice' + (selected ? ' selected' : '')}
      onClick={onClick}
      data-testid="exam-choice"
    >
      <span className="choice-key">{key}</span>
      <span className="choice-label">{label}</span>
    </button>
  );
}

/* ------------------------------- Resume a draft ------------------------------ */
/** One "Continue where you left off" card for a saved in-progress exam. */
function ResumeCard({
  session,
  sat,
  subjects,
  onResume,
  onDiscard,
}: {
  session: Resumable;
  sat: number;
  subjects: readonly Subject[];
  onResume: (s: Resumable) => void;
  onDiscard: (s: Resumable) => void;
}) {
  const subject = subjects.find((s) => s.id === session.subject);
  if (!subject) return null;
  const diffLabel = DIFFICULTIES.find((d) => d.id === session.difficulty)?.label;
  const at = Math.min(session.currentIndex + 1, session.questions.length);
  return (
    <div className="resume-card" style={accentCSS(subject, sat)}>
      <button
        className="resume-main"
        onClick={() => onResume(session)}
        data-testid={`resume-${session.subject}-${session.difficulty}`}
      >
        <span className="icon-chip">
          <SubjectIcon name={subject.icon} />
        </span>
        <span className="resume-text">
          <h3 className="subject-name">{subject.label}</h3>
          <p className="subject-meta">
            {diffLabel} · Question {at} of {session.questions.length}
          </p>
        </span>
        <span className="resume-go">{UIcon.arrow}</span>
      </button>
      <button
        className="resume-discard"
        onClick={() => onDiscard(session)}
        aria-label={`Discard your ${subject.label} exam`}
        title="Discard"
      >
        {UIcon.cross}
      </button>
    </div>
  );
}

/* --------------------------------- Dashboard -------------------------------- */
function Dashboard({
  sat,
  roleLabel,
  attemptCount,
  resumables,
  subjects,
  questionBank,
  onResume,
  onDiscard,
  onPick,
  onProgress,
}: {
  sat: number;
  roleLabel: string;
  attemptCount: number;
  resumables: Resumable[];
  subjects: readonly Subject[];
  questionBank: QuestionBank;
  onResume: (s: Resumable) => void;
  onDiscard: (s: Resumable) => void;
  onPick: (s: Subject) => void;
  onProgress: () => void;
}) {
  return (
    <div className="screen">
      <header className="topbar">
        <span className="topbar-spacer" />
        <span className="topbar-label">{roleLabel}</span>
        <span className="topbar-spacer" />
        <form action={signOut}>
          <button className="topbar-btn" type="submit" aria-label="Sign out" title="Sign out">
            {UIcon.signout}
          </button>
        </form>
      </header>
      <div className="hero">
        <p className="eyebrow">Exam Practice</p>
        <h1 className="display-title">Pick a subject to practise.</h1>
        <p className="subtitle">
          Short, focused mini exams. Take your time — every attempt makes the real thing easier.
        </p>
        <button className="progress-link" onClick={onProgress} data-testid="progress-link">
          {UIcon.retry}
          <span>Your progress{attemptCount > 0 ? ` · ${attemptCount} done` : ''}</span>
          {UIcon.arrow}
        </button>
      </div>
      {resumables.length > 0 && (
        <div className="continue-section">
          <p className="continue-title">Continue where you left off</p>
          {resumables.map((s) => (
            <ResumeCard
              key={`${s.subject}::${s.difficulty}`}
              session={s}
              sat={sat}
              subjects={subjects}
              onResume={onResume}
              onDiscard={onDiscard}
            />
          ))}
        </div>
      )}
      <div className="subject-grid">
        {subjects.map((s) => (
          <SubjectCard
            key={s.id}
            subject={s}
            sat={sat}
            questionCount={countQuestions(s.id, questionBank)}
            onClick={() => onPick(s)}
          />
        ))}
      </div>
    </div>
  );
}

/* -------------------------------- Progress -------------------------------- */
function ProgressScreen({
  progress,
  subjects,
  onHome,
}: {
  progress: ProgressData;
  subjects: readonly Subject[];
  onHome: () => void;
}) {
  return (
    <div className="screen">
      <TopBar onBack={onHome} onHome={onHome} label="Your progress" />
      <div className="screen-body">
        <div className="hero">
          <p className="eyebrow">Exam Practice</p>
          <h1 className="display-title" style={{ fontSize: 'var(--fs-h1)' }}>
            How you&rsquo;re doing
          </h1>
        </div>
        <ProgressView
          data={progress}
          subjects={subjects}
          emptyHint="No exams yet — finish a mini exam and your scores will show up here."
        />
      </div>
    </div>
  );
}

/* -------------------------------- Difficulty -------------------------------- */
function DifficultyScreen({
  subject,
  sat,
  questionBank,
  marking,
  onBack,
  onHome,
  onStart,
}: {
  subject: Subject;
  sat: number;
  questionBank: QuestionBank;
  marking: ExamMarking;
  onBack: () => void;
  onHome: () => void;
  onStart: (diff: DifficultyId) => void;
}) {
  const available = DIFFICULTIES.filter((d) =>
    difficultiesWithQuestions(subject.id, questionBank).includes(d.id),
  );
  const [sel, setSel] = useState<DifficultyId>(available[0]?.id ?? 'easy');
  // What this paper does with written questions, for the chosen difficulty.
  const bank = questionBank[subject.id]?.[sel] ?? [];
  const writtenLine = examWrittenLine(marking, {
    hasWritten: bank.some((q) => q.type === 'free'),
    leftOut: examPool(bank, marking.written !== 'unmarked').every((q) => q.type === 'mcq'),
  });
  const rankClass: Record<DifficultyId, string> = { easy: 'r1', medium: 'r2', hard: 'r3' };
  return (
    <div className="screen" style={accentCSS(subject, sat)}>
      <TopBar onBack={onBack} onHome={onHome} label={subject.label} />
      <div className="screen-body">
        <div className="diff-head">
          <span className="icon-chip">
            <SubjectIcon name={subject.icon} size={34} />
          </span>
          <div>
            <p className="eyebrow" style={{ color: 'var(--accent-ink)' }}>
              {subject.label}
            </p>
            <h1 className="display-title" style={{ fontSize: 'var(--fs-h1)' }}>
              Choose a difficulty
            </h1>
          </div>
        </div>
        <div className="diff-list">
          {available.map((d) => (
            <DifficultyCard
              key={d.id}
              diff={d}
              rankClass={rankClass[d.id]}
              selected={sel === d.id}
              onClick={() => setSel(d.id)}
            />
          ))}
        </div>
        {writtenLine ? (
          <p className="diff-note" data-testid="exam-written-line">
            {writtenLine}
          </p>
        ) : null}
        <div className="action-dock">
          <button
            className="btn btn-primary"
            disabled={available.length === 0}
            onClick={() => onStart(sel)}
            data-testid="start-exam"
          >
            Start mini exam {UIcon.arrow}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------- Exam ----------------------------------- */
/** An answer is a chosen index (mcq), a typed string (free), or null/blank. */
type Answer = number | string | null;

function isAnswered(q: Question, a: Answer): boolean {
  if (q.type === 'free') return typeof a === 'string' && a.trim() !== '';
  return typeof a === 'number';
}

function ExamScreen({
  subject,
  difficulty,
  sat,
  questions,
  answers,
  current,
  marking,
  onSetAnswer,
  onSetIndex,
  onBack,
  onHome,
  onFinish,
}: {
  subject: Subject;
  difficulty: DifficultyId;
  sat: number;
  questions: Question[];
  answers: Answer[];
  current: number;
  marking: ExamMarking;
  onSetAnswer: (index: number, value: Answer) => void;
  onSetIndex: (index: number) => void;
  onBack: () => void;
  onHome: () => void;
  onFinish: () => void;
}) {
  const i = current;
  const total = questions.length;
  const q = questions[i]!;
  const answer = answers[i] ?? null;
  const answered = isAnswered(q, answer);
  const pct = ((i + (answered ? 1 : 0)) / total) * 100;
  const isLast = i === total - 1;

  const setAnswer = (value: Answer) => onSetAnswer(i, value);
  const advance = () => {
    if (isLast) onFinish();
    else onSetIndex(i + 1);
  };

  return (
    <div className="screen" style={accentCSS(subject, sat)}>
      <TopBar
        onBack={i === 0 ? onBack : () => onSetIndex(i - 1)}
        onHome={onHome}
        label={subject.label}
      />
      <div className="screen-body">
        <div className="exam-top">
          <div className="progress-row">
            <span className="progress-count" data-testid="exam-progress">
              Question {i + 1} of {total}
            </span>
            <span className="progress-subject">
              {DIFFICULTIES.find((d) => d.id === difficulty)?.label}
            </span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: pct + '%' }} />
          </div>
        </div>

        <div className="question-card" key={i}>
          <span className="question-num">Question {i + 1}</span>
          <h2 className="question-text">{q.q}</h2>
          {q.type === 'free' ? (
            <>
              <textarea
                className="free-answer"
                value={typeof answer === 'string' ? answer : ''}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Type your answer…"
                rows={6}
                maxLength={4000}
                aria-label="Your answer"
                data-testid="exam-free-answer"
              />
              {marking.written === 'unmarked' ? (
                <p className="free-note" data-testid="exam-free-unmarked">
                  {EXAM_UNMARKED_WRITTEN}
                </p>
              ) : null}
            </>
          ) : (
            <div className="choices">
              {q.choices.map((c, ci) => (
                <Choice
                  key={ci}
                  label={c}
                  index={ci}
                  selected={answer === ci}
                  onClick={() => setAnswer(ci)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="action-dock">
          <button
            className="btn btn-primary"
            disabled={!answered}
            onClick={advance}
            data-testid="exam-next"
          >
            {isLast ? 'Finish exam' : 'Next question'} {!isLast && UIcon.arrow}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- Marking --------------------------------- */
function MarkingScreen({
  subject,
  sat,
  written,
}: {
  subject: Subject;
  sat: number;
  /** The exam has written answers an AI marks (up to a minute). */
  written: boolean;
}) {
  return (
    <div className="screen" style={accentCSS(subject, sat)}>
      <TopBar label="Results" />
      <div className="screen-body">
        <div className="marking" role="status" aria-live="polite">
          <span className="marking-spinner" />
          <p className="marking-text">Marking your answers…</p>
          {written ? (
            <p className="marking-note" data-testid="marking-written-note">
              Written answers can take up to a minute to mark.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------- Error ---------------------------------- */
/**
 * Why a finished exam wasn't marked. `unreachable`: the request never came back
 * (dropped connection, server restart or redeploy), so re-sending the same
 * answers can work. `refused`: the server answered and turned the paper down
 * (its questions changed mid-exam, or the session can no longer save exams) —
 * re-sending it can never succeed, so no retry is offered.
 */
type ExamErrorKind = 'unreachable' | 'refused';

function ExamErrorScreen({
  subject,
  sat,
  kind,
  onRetry,
  onHome,
}: {
  subject: Subject;
  sat: number;
  kind: ExamErrorKind;
  onRetry: () => void;
  onHome: () => void;
}) {
  const canRetry = kind === 'unreachable';
  return (
    <div className="screen" style={accentCSS(subject, sat)} data-testid={`exam-error-${kind}`}>
      <TopBar onHome={onHome} label="Results" />
      <div className="screen-body">
        <div className="marking" role="alert">
          <p className="marking-text">
            {canRetry
              ? 'We couldn’t save your exam just now. Your connection may have dropped — your answers are still here, so please try again.'
              : 'We couldn’t mark this exam. Its questions may have changed since you started, or you may need to sign in again — head back to subjects to start a fresh one.'}
          </p>
        </div>
        <div className="action-dock">
          {canRetry && (
            <button className="btn btn-primary" onClick={onRetry} data-testid="exam-retry">
              {UIcon.retry} Try again
            </button>
          )}
          <button className={canRetry ? 'btn btn-quiet' : 'btn btn-primary'} onClick={onHome}>
            Back to subjects
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- Results --------------------------------- */
function verdictFor(pct: number): { title: string; note: string } {
  if (pct >= 90)
    return {
      title: 'Outstanding work.',
      note: "You've really got this. Try Hard next to keep stretching.",
    };
  if (pct >= 70)
    return {
      title: 'Strong effort.',
      note: "Solid understanding — a little review and you'll have it nailed.",
    };
  if (pct >= 45)
    return {
      title: 'Good progress.',
      note: "You're getting there. Review the misses and run it again.",
    };
  return {
    title: 'A solid start.',
    note: "Every attempt teaches you something. Have another go — you'll climb fast.",
  };
}

/** One review row for a free-text item: bounded verdict fields only. */
function FreeReviewRow({
  q,
  status,
  score,
  maxScore,
  verdict,
}: {
  q: string;
  status: 'graded' | 'needs_review';
  score: number | null;
  maxScore: number;
  verdict: { verdict: string; gotRight: string[]; toReview: string[]; spelling: string[] } | null;
}) {
  if (status === 'needs_review' || verdict === null) {
    return (
      <div className="review-row" data-testid="review-row-free">
        <span className="review-mark pending">{UIcon.retry}</span>
        <div>
          <p className="review-q">{q}</p>
          <p className="review-a">{NEEDS_REVIEW_COPY}</p>
        </div>
      </div>
    );
  }
  const ok = isFreePass(score ?? 0, maxScore);
  return (
    <div className="review-row" data-testid="review-row-free">
      <span className={'review-mark ' + (ok ? 'ok' : 'err')}>{ok ? UIcon.check : UIcon.cross}</span>
      <div>
        <p className="review-q">{q}</p>
        <p className="review-a">
          Score: <b>{score}</b>/{maxScore} · {verdict.verdict}
        </p>
        {verdict.gotRight.length > 0 && (
          <p className="review-a">Got right: {verdict.gotRight.join('; ')}</p>
        )}
        {verdict.toReview.length > 0 && (
          <p className="review-a">To review: {verdict.toReview.join('; ')}</p>
        )}
        {verdict.spelling.length > 0 && (
          <p className="review-a">Spelling: {verdict.spelling.join('; ')}</p>
        )}
      </div>
    </div>
  );
}

function ResultsScreen({
  subject,
  sat,
  attempt,
  onRetry,
  onChangeDiff,
  onHome,
}: {
  subject: Subject;
  sat: number;
  attempt: AttemptRecord;
  onRetry: () => void;
  onChangeDiff: () => void;
  onHome: () => void;
}) {
  const { correct, total, scorePct: pct } = attempt;
  const v = verdictFor(pct);

  return (
    <div className="screen" style={accentCSS(subject, sat)}>
      <TopBar onHome={onHome} label="Results" />
      <div className="screen-body">
        <div className="results-head">
          <div
            className="score-ring"
            style={{ '--pct': pct } as CSSProperties}
            data-testid="results-score"
          >
            <div>
              <div className="score-num">
                {correct}
                <span style={{ fontSize: '1.4rem', color: 'var(--text-faint)' }}>/{total}</span>
              </div>
              <div className="score-of">{pct}% correct</div>
            </div>
          </div>
          <h1 className="results-verdict">{v.title}</h1>
          <p className="results-note">{v.note}</p>
        </div>

        <div className="tally">
          <div className="tally-card">
            <div className="tally-num ok">{correct}</div>
            <div className="tally-label">Correct</div>
          </div>
          <div className="tally-card">
            <div className="tally-num err">{total - correct}</div>
            <div className="tally-label">To review</div>
          </div>
        </div>

        <div className="review">
          <p className="review-title">Review</p>
          {attempt.items.map((item, idx) => {
            const n = normalizeAttemptItem(item);
            if (n.kind === 'free') {
              return (
                <FreeReviewRow
                  key={idx}
                  q={n.item.q}
                  status={n.item.status}
                  score={n.item.score}
                  maxScore={n.item.maxScore}
                  verdict={n.item.verdict}
                />
              );
            }
            const mcq = n.item;
            const ok = mcq.chosen === mcq.answer;
            return (
              <div className="review-row" key={idx} data-testid="review-row-mcq">
                <span className={'review-mark ' + (ok ? 'ok' : 'err')}>
                  {ok ? UIcon.check : UIcon.cross}
                </span>
                <div>
                  <p className="review-q">{mcq.q}</p>
                  {!ok && (
                    <p className="review-a">
                      You chose “{mcq.chosen != null ? mcq.choices[mcq.chosen] : '—'}” · Answer:{' '}
                      <b>{mcq.choices[mcq.answer]}</b>
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="action-dock">
          <button className="btn btn-primary" onClick={onRetry}>
            {UIcon.retry} Retry this exam
          </button>
          <button className="btn btn-ghost" onClick={onChangeDiff}>
            Choose another difficulty
          </button>
          <button className="btn btn-quiet" onClick={onHome} data-testid="results-home">
            Back to subjects
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------ App ----------------------------------- */
type Screen =
  'dashboard' | 'difficulty' | 'exam' | 'marking' | 'results' | 'examError' | 'progress';

/**
 * A saved in-progress exam, reconstructed server-side (in `page.tsx`) into the
 * exact paper + the user's answers so the dashboard can offer to resume it. The
 * questions are rebuilt and validated from the persisted ids via
 * `resolveExamPaper`.
 */
export type Resumable = {
  subject: string;
  difficulty: DifficultyId;
  questions: Question[];
  answers: Answer[];
  currentIndex: number;
};

const comboKey = (subject: string, difficulty: string) => `${subject}::${difficulty}`;

/** Debounce for autosaving free-text typing; Next/Back flush immediately. */
const AUTOSAVE_DELAY = 700;

export function ExamApp({
  role,
  studentMode = false,
  initialProgress,
  resumable = [],
  subjects = SUBJECTS,
  questionBank = QUESTIONS,
  marking,
}: {
  role: SessionRole;
  /** True when a parent is playing as a student — shows the exit affordance. */
  studentMode?: boolean;
  initialProgress: ProgressData;
  /** Saved in-progress exams (server-fetched) the user can resume. */
  resumable?: Resumable[];
  /** Live public bank from the `/` RSC. Defaults to the build-time merge. */
  subjects?: readonly Subject[];
  questionBank?: QuestionBank;
  /**
   * Whether this household's AI marks written answers here. Unmarked: papers
   * leave written questions out where they can, and the exam says so.
   */
  marking: ExamMarking;
}) {
  const router = useRouter();
  const sat = 1; // balanced; the Tweaks panel is not shipped
  const roleLabel = role === 'parent' ? 'Parent' : 'Student';

  const [screen, setScreen] = useState<Screen>('dashboard');
  const [subject, setSubject] = useState<Subject | null>(null);
  const [difficulty, setDifficulty] = useState<DifficultyId>('medium');
  const [progress, setProgress] = useState<ProgressData>(initialProgress);
  const [, startSave] = useTransition();
  const [questions, setQuestions] = useState<Question[]>([]);
  // The active exam's answers + position, lifted here (not in ExamScreen) so they
  // survive a hop to the dashboard, drive the autosave, and seed a resume.
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [current, setCurrent] = useState(0);
  // The subject of the exam currently mid-flight (null when none) — distinct from
  // the navigation `subject`, which changes when you browse other subject cards.
  // Anchoring the live "continue" card to THIS (not `subject`) keeps the card and
  // its questions/answers in sync even after you tap a different subject tile.
  // Cleared on finish/discard, or when the server refuses the finished paper.
  const [examSubject, setExamSubject] = useState<Subject | null>(null);
  // Combos hidden from the resume list this session (discarded or just finished),
  // so a card disappears immediately without waiting for a server refresh.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  // Exams left mid-way this session for another one, newest first. Nothing
  // refreshes the page-load `resumable` prop while ExamApp is mounted, so for
  // the same combo these always win over it: resuming the older server copy
  // would roll back answers given since, and the next autosave would store that.
  const [parked, setParked] = useState<Resumable[]>([]);
  const [scored, setScored] = useState<AttemptRecord | null>(null);
  // The last submitted payload, kept so the error screen can re-send the exact
  // answers (the exam screen has unmounted by then) without re-grading anything.
  const [pending, setPending] = useState<RecordAttemptInput | null>(null);
  const [examError, setExamError] = useState<ExamErrorKind>('unreachable');
  // The debounced autosave waiting to run, if any (its timer + the save itself).
  const pendingSave = useRef<{ timer: ReturnType<typeof setTimeout>; run: () => void } | null>(
    null,
  );
  // Combos whose draft row may not exist yet because `beginExamSession` hasn't
  // succeeded. The update-only autosave would be a no-op for them, so their next
  // checkpoint tries to create the draft again instead.
  const uncreated = useRef<Set<string>>(new Set());

  const cancelPendingSave = () => {
    if (pendingSave.current) {
      clearTimeout(pendingSave.current.timer);
      pendingSave.current = null;
    }
  };
  // Leaving the exam (Home, another exam, finishing, exiting student mode) is a
  // checkpoint too: send the waiting autosave now instead of dropping it.
  const flushPendingSave = () => pendingSave.current?.run();

  // So is hiding or closing the tab — a phone discarding it in the background is
  // the case resume exists for. Best-effort: a Server Action can't use
  // sendBeacon, so a page that is unloading may still lose this last save.
  useEffect(() => {
    const flush = () => pendingSave.current?.run();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // Background writes (autosave, discard) are best-effort. A rejection — a
  // dropped connection, the server restarting, a redeploy that retired the
  // action — must never take the exam down: the answers stay in memory and the
  // next checkpoint re-sends the full snapshot. Next's own redirect / not-found
  // signals still propagate.
  const inBackground = (task: () => Promise<void>) => {
    startSave(async () => {
      try {
        await task();
      } catch (caught) {
        unstable_rethrow(caught);
      }
    });
  };

  // Persist the in-progress exam so a reload / closed browser can resume it. The
  // full snapshot is sent every time. `beginExamSession` (on start) creates the
  // row; the autosave `saveExamProgress` is update-only, so a debounced save still
  // in flight when the exam is finished/discarded can't resurrect a cleared draft.
  // Only while creating the row hasn't succeeded does the autosave retry
  // `beginExamSession`; Next runs Server Actions one at a time, so that retry
  // always lands before a later finish/discard, which also end the retrying.
  const persist = (
    action: typeof beginExamSession | typeof saveExamProgress,
    subj: Subject,
    diff: DifficultyId,
    qs: Question[],
    ans: Answer[],
    idx: number,
  ) => {
    const key = comboKey(subj.id, diff);
    const create = action === beginExamSession || uncreated.current.has(key);
    if (create) uncreated.current.add(key);
    inBackground(async () => {
      const res = await (create ? beginExamSession : saveExamProgress)({
        subject: subj.id,
        difficulty: diff,
        questionIds: qs.map((q) => q.id),
        answers: ans,
        currentIndex: idx,
      });
      if (create && res.ok) uncreated.current.delete(key);
    });
  };

  const dismiss = (subjectId: string, diff: string) =>
    setDismissed((prev) => new Set(prev).add(comboKey(subjectId, diff)));

  // Another exam is about to become the live one: keep the current live exam
  // (answers + position) as a parked draft, and drop any parked copy of the
  // incoming combo — the incoming exam supersedes it.
  const replaceLiveExam = (incoming: string) => {
    const live: Resumable | null = examSubject
      ? { subject: examSubject.id, difficulty, questions, answers, currentIndex: current }
      : null;
    setParked((prev) => {
      const rest = prev.filter((p) => {
        const k = comboKey(p.subject, p.difficulty);
        return k !== incoming && (!live || k !== comboKey(live.subject, live.difficulty));
      });
      return live && comboKey(live.subject, live.difficulty) !== incoming ? [live, ...rest] : rest;
    });
  };

  const goHome = () => {
    // Leaving to the dashboard does NOT discard — the autosaved draft stays
    // resumable (the live card covers it while ExamApp is still mounted).
    flushPendingSave();
    setScreen('dashboard');
  };
  const pickSubject = (s: Subject) => {
    setSubject(s);
    setScreen('difficulty');
  };
  const startExam = (diff: DifficultyId) => {
    if (!subject) return;
    const qs = buildExam(subject.id, diff, questionBank, {
      written: marking.written !== 'unmarked',
    });
    if (qs.length === 0) return;
    flushPendingSave(); // the exam being left keeps its latest answers
    replaceLiveExam(comboKey(subject.id, diff));
    const blank: Answer[] = qs.map(() => null);
    setDifficulty(diff);
    setQuestions(qs);
    setAnswers(blank);
    setCurrent(0);
    setExamSubject(subject);
    setDismissed((prev) => {
      // Re-starting a combo makes it eligible to show again.
      if (!prev.has(comboKey(subject.id, diff))) return prev;
      const next = new Set(prev);
      next.delete(comboKey(subject.id, diff));
      return next;
    });
    setScreen('exam');
    persist(beginExamSession, subject, diff, qs, blank, 0); // create the resumable draft up-front
  };

  // Restore a saved draft straight into the exam at the question it left off.
  // `s` is the newest copy of that combo: the resume list puts in-memory drafts
  // ahead of the page-load snapshot.
  const resumeSession = (s: Resumable) => {
    const subj = subjects.find((x) => x.id === s.subject);
    if (!subj) return;
    flushPendingSave();
    replaceLiveExam(comboKey(s.subject, s.difficulty));
    setSubject(subj);
    setDifficulty(s.difficulty);
    setQuestions(s.questions);
    setAnswers(s.answers);
    setCurrent(Math.min(s.currentIndex, Math.max(s.questions.length - 1, 0)));
    setExamSubject(subj);
    setScreen('exam');
  };

  const discardSession = (s: Resumable) => {
    const key = comboKey(s.subject, s.difficulty);
    dismiss(s.subject, s.difficulty);
    uncreated.current.delete(key); // nothing may recreate it now
    setParked((prev) => prev.filter((p) => comboKey(p.subject, p.difficulty) !== key));
    if (examSubject?.id === s.subject && difficulty === s.difficulty) {
      cancelPendingSave();
      setExamSubject(null);
    }
    inBackground(async () => {
      await discardExamSession({ subject: s.subject, difficulty: s.difficulty });
    });
  };

  // Controlled answer/navigation from ExamScreen, with autosave attached.
  const setAnswerAt = (index: number, value: Answer) => {
    if (!subject) return;
    const next = answers.slice();
    next[index] = value;
    setAnswers(next);
    cancelPendingSave();
    const subj = subject;
    const diff = difficulty;
    const qs = questions;
    const idx = current;
    const run = () => {
      cancelPendingSave(); // runs once, whether the timer fires or it is flushed
      persist(saveExamProgress, subj, diff, qs, next, idx);
    };
    pendingSave.current = { timer: setTimeout(run, AUTOSAVE_DELAY), run };
  };
  const goToIndex = (index: number) => {
    if (!subject) return;
    setCurrent(index);
    cancelPendingSave(); // Next/Back is a natural checkpoint — flush now.
    persist(saveExamProgress, subject, difficulty, questions, answers, index);
  };

  // Submit a payload and let the server score + grade it; results render from
  // the returned record (the client holds no answer keys to self-score).
  const send = (payload: RecordAttemptInput) => {
    setPending(payload);
    setScreen('marking');
    startSave(async () => {
      let res: RecordAttemptResult;
      try {
        res = await recordAttempt(payload);
      } catch (caught) {
        unstable_rethrow(caught);
        // No answer came back. Keep `pending` (and the live draft) so "Try
        // again" re-sends exactly these answers.
        setExamError('unreachable');
        setScreen('examError');
        return;
      }
      // Either way this paper is settled, so hide it locally too: finished (the
      // server cleared its draft), or refused and never markable as it is — a
      // resume card for it would be a dead end.
      uncreated.current.delete(comboKey(payload.subject, payload.difficulty));
      setExamSubject(null);
      dismiss(payload.subject, payload.difficulty);
      if (res.ok) {
        setScored(res.attempt);
        setProgress(res.progress);
        setScreen('results');
      } else {
        setExamError('refused');
        setScreen('examError');
      }
    });
  };

  const finishExam = () => {
    if (!subject) return;
    // Send a waiting autosave now rather than drop it: it runs ahead of the
    // submit (Server Actions go one at a time), so it can't resurrect the draft
    // the submit clears, and the draft keeps the last answer if the submit fails.
    flushPendingSave();
    const items: RecordAttemptInput['items'] = questions.map((q, idx) => {
      const a = answers[idx] ?? null;
      if (q.type === 'free') {
        return { type: 'free', id: q.id, response: typeof a === 'string' ? a : '' };
      }
      return { type: 'mcq', id: q.id, chosen: typeof a === 'number' ? a : null };
    });
    send({ subject: subject.id, difficulty, items });
  };
  const resend = () => {
    if (pending) send(pending);
  };
  const retry = () => {
    if (!subject) return;
    startExam(difficulty);
  };

  // The resume cards: the live in-memory exam (if any), then the exams parked
  // this session, then the server-fetched drafts. An in-memory copy always wins
  // over the page-load snapshot of the same combo; dismissed combos are hidden.
  const liveCard: Resumable | null = examSubject
    ? { subject: examSubject.id, difficulty, questions, answers, currentIndex: current }
    : null;
  const local = [...(liveCard ? [liveCard] : []), ...parked];
  const localKeys = new Set(local.map((r) => comboKey(r.subject, r.difficulty)));
  const resumables: Resumable[] = [
    ...local,
    ...resumable.filter((r) => {
      const k = comboKey(r.subject, r.difficulty);
      return !dismissed.has(k) && !localKeys.has(k);
    }),
  ];

  let view;
  if (screen === 'progress') {
    view = <ProgressScreen progress={progress} subjects={subjects} onHome={goHome} />;
  } else if (screen === 'dashboard' || !subject) {
    view = (
      <Dashboard
        sat={sat}
        roleLabel={roleLabel}
        attemptCount={progress.attempts.length}
        resumables={resumables}
        subjects={subjects}
        questionBank={questionBank}
        onResume={resumeSession}
        onDiscard={discardSession}
        onPick={pickSubject}
        onProgress={() => setScreen('progress')}
      />
    );
  } else if (screen === 'difficulty') {
    view = (
      <DifficultyScreen
        subject={subject}
        sat={sat}
        questionBank={questionBank}
        marking={marking}
        onBack={goHome}
        onHome={goHome}
        onStart={startExam}
      />
    );
  } else if (screen === 'exam') {
    view = (
      <ExamScreen
        subject={subject}
        difficulty={difficulty}
        sat={sat}
        questions={questions}
        answers={answers}
        current={current}
        marking={marking}
        onSetAnswer={setAnswerAt}
        onSetIndex={goToIndex}
        onBack={() => setScreen('difficulty')}
        onHome={goHome}
        onFinish={finishExam}
      />
    );
  } else if (screen === 'marking') {
    view = (
      <MarkingScreen
        subject={subject}
        sat={sat}
        written={
          marking.written !== 'unmarked' && questions.some((question) => question.type === 'free')
        }
      />
    );
  } else if (screen === 'examError') {
    view = (
      <ExamErrorScreen
        subject={subject}
        sat={sat}
        kind={examError}
        onRetry={resend}
        onHome={goHome}
      />
    );
  } else if (screen === 'results' && scored) {
    view = (
      <ResultsScreen
        subject={subject}
        sat={sat}
        attempt={scored}
        onRetry={retry}
        onChangeDiff={() => setScreen('difficulty')}
        onHome={goHome}
      />
    );
  } else {
    // Defensive fallback (e.g. results with no scored record) — back to difficulty.
    view = (
      <DifficultyScreen
        subject={subject}
        sat={sat}
        questionBank={questionBank}
        marking={marking}
        onBack={goHome}
        onHome={goHome}
        onStart={startExam}
      />
    );
  }

  const exitStudentMode = () => {
    flushPendingSave(); // queued ahead of the switch, while the save is still allowed
    startSave(async () => {
      await setStudentMode(false);
      router.refresh();
    });
  };

  return (
    <div className="stage">
      <div className="app-frame">
        {studentMode && (
          <div className="student-mode-bar" role="status">
            <span className="student-mode-tag">Playing as student</span>
            <button className="student-mode-exit" onClick={exitStudentMode} type="button">
              {UIcon.signout}
              <span>Exit student mode</span>
            </button>
          </div>
        )}
        {view}
      </div>
    </div>
  );
}
