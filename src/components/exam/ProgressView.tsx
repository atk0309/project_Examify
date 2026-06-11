'use client';

/* ============================================================================
   EXAMIFY — PROGRESS VIEW (shared)
   Read-only roll-up of persisted attempts, used by the student's own "Your
   progress" screen and the parent's read-only dashboard. Purely presentational
   over a `ProgressData` snapshot — no fetching, no mutation.
   ========================================================================== */
import { useState } from 'react';
import {
  accentCSS,
  DIFFICULTIES,
  SUBJECTS,
  type DifficultyId,
  type Subject,
} from '@/lib/exam/data';
import {
  isFreePass,
  normalizeAttemptItem,
  type AttemptRecord,
  type ProgressData,
} from '@/lib/exam/attempts';
import { SubjectIcon, UIcon } from './icons';

const SUBJECT_BY_ID = new Map(SUBJECTS.map((s) => [s.id, s]));
const DIFFICULTY_LABEL = new Map(DIFFICULTIES.map((d) => [d.id as DifficultyId, d.label]));

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function SummaryCard({
  subject,
  summary,
}: {
  subject: Subject;
  summary: ProgressData['subjects'][number];
}) {
  return (
    <div className="summary-card" style={accentCSS(subject, 1)}>
      <div className="summary-head">
        <span className="icon-chip">
          <SubjectIcon name={subject.icon} size={26} />
        </span>
        <div>
          <h3 className="summary-name">{subject.label}</h3>
          <p className="summary-attempts">
            {summary.attempts} {summary.attempts === 1 ? 'attempt' : 'attempts'}
          </p>
        </div>
      </div>
      <div className="summary-stats">
        <div className="stat">
          <span className="stat-num">{summary.best}%</span>
          <span className="stat-label">Best</span>
        </div>
        <div className="stat">
          <span className="stat-num">{summary.average}%</span>
          <span className="stat-label">Average</span>
        </div>
        <div className="stat">
          <span className="stat-num">{summary.last}%</span>
          <span className="stat-label">Latest</span>
        </div>
      </div>
    </div>
  );
}

function AttemptRow({ attempt }: { attempt: AttemptRecord }) {
  const [open, setOpen] = useState(false);
  const subject = SUBJECT_BY_ID.get(attempt.subject);
  const label = subject?.label ?? attempt.subject;
  const diff = DIFFICULTY_LABEL.get(attempt.difficulty) ?? attempt.difficulty;

  return (
    <div className="attempt-row" style={subject ? accentCSS(subject, 1) : undefined}>
      <button className="attempt-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="attempt-info">
          <span className="attempt-subject">{label}</span>
          <span className="attempt-meta">
            {diff} · {formatDate(attempt.createdAt)}
          </span>
        </span>
        <span className="attempt-score">
          {attempt.correct}/{attempt.total}
          <span className="attempt-pct">{attempt.scorePct}%</span>
        </span>
        <span className={'attempt-caret' + (open ? ' open' : '')}>{UIcon.arrow}</span>
      </button>
      {open && (
        <div className="review">
          {attempt.items.map((item, idx) => {
            const n = normalizeAttemptItem(item);
            if (n.kind === 'free') {
              const f = n.item;
              if (f.status === 'needs_review' || f.verdict === null) {
                return (
                  <div className="review-row" key={idx}>
                    <span className="review-mark pending">{UIcon.retry}</span>
                    <div>
                      <p className="review-q">{f.q}</p>
                      <p className="review-a">Saved for review.</p>
                    </div>
                  </div>
                );
              }
              const ok = isFreePass(f.score ?? 0, f.maxScore);
              return (
                <div className="review-row" key={idx}>
                  <span className={'review-mark ' + (ok ? 'ok' : 'err')}>
                    {ok ? UIcon.check : UIcon.cross}
                  </span>
                  <div>
                    <p className="review-q">{f.q}</p>
                    <p className="review-a">
                      Score: <b>{f.score}</b>/{f.maxScore} · {f.verdict.verdict}
                    </p>
                  </div>
                </div>
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
                      Chose “{mcq.chosen != null ? mcq.choices[mcq.chosen] : '—'}” · Answer:{' '}
                      <b>{mcq.choices[mcq.answer]}</b>
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ProgressView({ data, emptyHint }: { data: ProgressData; emptyHint: string }) {
  if (data.attempts.length === 0) {
    return (
      <div className="progress-empty">
        <span className="progress-empty-mark">{UIcon.retry}</span>
        <p className="progress-empty-text">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div className="progress-view">
      <section>
        <p className="eyebrow">By subject</p>
        <div className="summary-grid">
          {data.subjects.map((s) => {
            const subject = SUBJECT_BY_ID.get(s.subjectId);
            if (!subject) return null;
            return <SummaryCard key={s.subjectId} subject={subject} summary={s} />;
          })}
        </div>
      </section>

      <section>
        <p className="eyebrow">Recent attempts</p>
        <div className="attempt-list">
          {data.attempts.map((a) => (
            <AttemptRow key={a.id} attempt={a} />
          ))}
        </div>
      </section>
    </div>
  );
}
