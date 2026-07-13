'use client';

/* ============================================================================
   EXAMIFY — APP  (screens + flow state)
   Flow: dashboard -> difficulty -> exam -> marking -> results
   ----------------------------------------------------------------------------
   Results are SERVER-DRIVEN: the public question bank carries no answer keys
   (those are server-only), so the client cannot self-score. On finish we submit
   the attempt, the server validates + scores + grades free-text, and the
   results render from the returned `AttemptRecord`. A brief "Marking…" state
   covers the round-trip; a failed submit shows a retry screen.
   ========================================================================== */
import { useRef, useState, useTransition, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { recordAttempt, type RecordAttemptInput } from '@/actions/recordAttempt';
import { beginExamSession, saveExamProgress } from '@/actions/saveExamProgress';
import { discardExamSession } from '@/actions/discardExamSession';
import { setStudentMode } from '@/actions/toggleStudentMode';
import { signOut } from '@/actions/signOut';
import {
  accentCSS,
  buildExam,
  countQuestions,
  DIFFICULTIES,
  SUBJECTS,
  type DifficultyId,
  type Question,
  type Subject,
} from '@/lib/exam/data';
import {
  isFreePass,
  normalizeAttemptItem,
  type AttemptRecord,
  type ProgressData,
} from '@/lib/exam/attempts';
import type { SessionRole } from '@/lib/auth';
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
}: {
  subject: Subject;
  sat: number;
  onClick: () => void;
}) {
  const count = countQuestions(subject.id);
  return (
    <button className="subject-card" style={accentCSS(subject, sat)} onClick={onClick}>
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
    <button className={'diff-card' + (selected ? ' selected' : '')} onClick={onClick}>
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
    <button className={'choice' + (selected ? ' selected' : '')} onClick={onClick}>
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
  onResume,
  onDiscard,
}: {
  session: Resumable;
  sat: number;
  onResume: (s: Resumable) => void;
  onDiscard: (s: Resumable) => void;
}) {
  const subject = SUBJECTS.find((s) => s.id === session.subject);
  if (!subject) return null;
  const diffLabel = DIFFICULTIES.find((d) => d.id === session.difficulty)?.label;
  const at = Math.min(session.currentIndex + 1, session.questions.length);
  return (
    <div className="resume-card" style={accentCSS(subject, sat)}>
      <button className="resume-main" onClick={() => onResume(session)}>
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
  onResume,
  onDiscard,
  onPick,
  onProgress,
}: {
  sat: number;
  roleLabel: string;
  attemptCount: number;
  resumables: Resumable[];
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
        <button className="progress-link" onClick={onProgress}>
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
              onResume={onResume}
              onDiscard={onDiscard}
            />
          ))}
        </div>
      )}
      <div className="subject-grid">
        {SUBJECTS.map((s) => (
          <SubjectCard key={s.id} subject={s} sat={sat} onClick={() => onPick(s)} />
        ))}
      </div>
    </div>
  );
}

/* -------------------------------- Progress -------------------------------- */
function ProgressScreen({ progress, onHome }: { progress: ProgressData; onHome: () => void }) {
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
  onBack,
  onHome,
  onStart,
}: {
  subject: Subject;
  sat: number;
  onBack: () => void;
  onHome: () => void;
  onStart: (diff: DifficultyId) => void;
}) {
  const [sel, setSel] = useState<DifficultyId>('medium');
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
          {DIFFICULTIES.map((d) => (
            <DifficultyCard
              key={d.id}
              diff={d}
              rankClass={rankClass[d.id]}
              selected={sel === d.id}
              onClick={() => setSel(d.id)}
            />
          ))}
        </div>
        <div className="action-dock">
          <button className="btn btn-primary" onClick={() => onStart(sel)}>
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
            <span className="progress-count">
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
            <textarea
              className="free-answer"
              value={typeof answer === 'string' ? answer : ''}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Type your answer…"
              rows={6}
              maxLength={4000}
              aria-label="Your answer"
            />
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
          <button className="btn btn-primary" disabled={!answered} onClick={advance}>
            {isLast ? 'Finish exam' : 'Next question'} {!isLast && UIcon.arrow}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- Marking --------------------------------- */
function MarkingScreen({ subject, sat }: { subject: Subject; sat: number }) {
  return (
    <div className="screen" style={accentCSS(subject, sat)}>
      <TopBar label="Results" />
      <div className="screen-body">
        <div className="marking" role="status" aria-live="polite">
          <span className="marking-spinner" />
          <p className="marking-text">Marking your answers…</p>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------- Error ---------------------------------- */
function ExamErrorScreen({
  subject,
  sat,
  onRetry,
  onHome,
}: {
  subject: Subject;
  sat: number;
  onRetry: () => void;
  onHome: () => void;
}) {
  return (
    <div className="screen" style={accentCSS(subject, sat)}>
      <TopBar onHome={onHome} label="Results" />
      <div className="screen-body">
        <div className="marking">
          <p className="marking-text">
            We couldn&rsquo;t save your exam just now. Your connection may have dropped — please try
            again.
          </p>
        </div>
        <div className="action-dock">
          <button className="btn btn-primary" onClick={onRetry}>
            {UIcon.retry} Try again
          </button>
          <button className="btn btn-quiet" onClick={onHome}>
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
      <div className="review-row">
        <span className="review-mark pending">{UIcon.retry}</span>
        <div>
          <p className="review-q">{q}</p>
          <p className="review-a">Saved for review — we&rsquo;ll mark this one shortly.</p>
        </div>
      </div>
    );
  }
  const ok = isFreePass(score ?? 0, maxScore);
  return (
    <div className="review-row">
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
          <div className="score-ring" style={{ '--pct': pct } as CSSProperties}>
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
              <div className="review-row" key={idx}>
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
          <button className="btn btn-quiet" onClick={onHome}>
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
 * questions are rebuilt from the persisted ids via `questionsByIds`.
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
}: {
  role: SessionRole;
  /** True when a parent is playing as a student — shows the exit affordance. */
  studentMode?: boolean;
  initialProgress: ProgressData;
  /** Saved in-progress exams (server-fetched) the user can resume. */
  resumable?: Resumable[];
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
  // Cleared on finish/discard.
  const [examSubject, setExamSubject] = useState<Subject | null>(null);
  // Combos hidden from the resume list this session (discarded or just finished),
  // so a card disappears immediately without waiting for a server refresh.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [scored, setScored] = useState<AttemptRecord | null>(null);
  // The last submitted payload, kept so the error screen can re-send the exact
  // answers (the exam screen has unmounted by then) without re-grading anything.
  const [pending, setPending] = useState<RecordAttemptInput | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingSave = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
  };

  // Persist the in-progress exam so a reload / closed browser can resume it. The
  // full snapshot is sent every time. `beginExamSession` (on start) creates the
  // row; the autosave `saveExamProgress` is update-only, so a debounced save still
  // in flight when the exam is finished/discarded can't resurrect a cleared draft.
  const persist = (
    action: typeof beginExamSession | typeof saveExamProgress,
    subj: Subject,
    diff: DifficultyId,
    qs: Question[],
    ans: Answer[],
    idx: number,
  ) => {
    startSave(async () => {
      await action({
        subject: subj.id,
        difficulty: diff,
        questionIds: qs.map((q) => q.id),
        answers: ans,
        currentIndex: idx,
      });
    });
  };

  const dismiss = (subjectId: string, diff: string) =>
    setDismissed((prev) => new Set(prev).add(comboKey(subjectId, diff)));

  const goHome = () => {
    // Leaving to the dashboard does NOT discard — the autosaved draft stays
    // resumable (the live card covers it while ExamApp is still mounted).
    cancelPendingSave();
    setScreen('dashboard');
  };
  const pickSubject = (s: Subject) => {
    setSubject(s);
    setScreen('difficulty');
  };
  const startExam = (diff: DifficultyId) => {
    if (!subject) return;
    cancelPendingSave();
    const qs = buildExam(subject.id, diff);
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
  const resumeSession = (s: Resumable) => {
    const subj = SUBJECTS.find((x) => x.id === s.subject);
    if (!subj) return;
    cancelPendingSave();
    setSubject(subj);
    setDifficulty(s.difficulty);
    setQuestions(s.questions);
    setAnswers(s.answers);
    setCurrent(Math.min(s.currentIndex, Math.max(s.questions.length - 1, 0)));
    setExamSubject(subj);
    setScreen('exam');
  };

  const discardSession = (s: Resumable) => {
    dismiss(s.subject, s.difficulty);
    if (examSubject?.id === s.subject && difficulty === s.difficulty) {
      setExamSubject(null);
    }
    startSave(async () => {
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
    saveTimer.current = setTimeout(
      () => persist(saveExamProgress, subj, diff, qs, next, current),
      AUTOSAVE_DELAY,
    );
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
      const res = await recordAttempt(payload);
      if (res.ok) {
        // The exam is done — the server cleared its draft; hide it locally too.
        setExamSubject(null);
        dismiss(payload.subject, payload.difficulty);
        setScored(res.attempt);
        setProgress(res.progress);
        setScreen('results');
      } else {
        setScreen('examError');
      }
    });
  };

  const finishExam = () => {
    if (!subject) return;
    cancelPendingSave(); // don't let a debounced save resurrect the finished draft
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

  // The resume cards: the live in-memory exam (if any) plus the server-fetched
  // drafts, de-duped by combo and minus anything dismissed this session.
  const liveCard: Resumable | null = examSubject
    ? { subject: examSubject.id, difficulty, questions, answers, currentIndex: current }
    : null;
  const resumables: Resumable[] = [
    ...(liveCard ? [liveCard] : []),
    ...resumable.filter((r) => {
      const k = comboKey(r.subject, r.difficulty);
      if (dismissed.has(k)) return false;
      if (liveCard && k === comboKey(liveCard.subject, liveCard.difficulty)) return false;
      return true;
    }),
  ];

  let view;
  if (screen === 'progress') {
    view = <ProgressScreen progress={progress} onHome={goHome} />;
  } else if (screen === 'dashboard' || !subject) {
    view = (
      <Dashboard
        sat={sat}
        roleLabel={roleLabel}
        attemptCount={progress.attempts.length}
        resumables={resumables}
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
        onSetAnswer={setAnswerAt}
        onSetIndex={goToIndex}
        onBack={() => setScreen('difficulty')}
        onHome={goHome}
        onFinish={finishExam}
      />
    );
  } else if (screen === 'marking') {
    view = <MarkingScreen subject={subject} sat={sat} />;
  } else if (screen === 'examError') {
    view = <ExamErrorScreen subject={subject} sat={sat} onRetry={resend} onHome={goHome} />;
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
        onBack={goHome}
        onHome={goHome}
        onStart={startExam}
      />
    );
  }

  const exitStudentMode = () => {
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
