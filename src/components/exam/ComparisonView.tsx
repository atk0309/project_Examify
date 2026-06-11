'use client';

/* ============================================================================
   EXAMIFY — COMPARISON VIEW
   Side-by-side parent-vs-child progress, shown on the parent dashboard. Purely
   presentational over two `ProgressData` snapshots plus their uncapped score
   histories (oldest-first `scorePct[]` from `getScoreHistory`). The totals and
   the "by attempt number" progression use the uncapped histories so attempt #1
   is the *true* first attempt; the per-subject panel is labelled "recent"
   because it composes the 50-capped `ProgressData.subjects`.
   ========================================================================== */
import { SUBJECTS } from '@/lib/exam/data';
import { overallAverage, type ProgressData, type SubjectSummary } from '@/lib/exam/attempts';

const SUBJECT_BY_ID = new Map(SUBJECTS.map((s) => [s.id, s]));

type Side = {
  label: string;
  summaries: Map<string, SubjectSummary>;
  history: number[];
};

function toSide(label: string, data: ProgressData, history: number[]): Side {
  return { label, summaries: new Map(data.subjects.map((s) => [s.subjectId, s])), history };
}

/** A small score bar; height scales with the score (0–100%). */
function Bar({ score }: { score: number }) {
  return (
    <span className="compare-bar" title={`${score}%`}>
      <span className="compare-bar-fill" style={{ height: `${Math.max(score, 4)}%` }} />
    </span>
  );
}

function Progression({ label, history }: { label: string; history: number[] }) {
  return (
    <div className="compare-prog">
      <span className="compare-prog-label">{label}</span>
      {history.length === 0 ? (
        <span className="compare-prog-empty">No attempts yet</span>
      ) : (
        <span className="compare-bars">
          {history.map((score, i) => (
            <Bar key={i} score={score} />
          ))}
        </span>
      )}
    </div>
  );
}

export function ComparisonView({
  youLabel,
  childLabel,
  you,
  child,
  youHistory,
  childHistory,
}: {
  youLabel: string;
  childLabel: string;
  you: ProgressData; // capped (recent) — drives the per-subject panel
  child: ProgressData; // capped (recent)
  youHistory: number[]; // uncapped, oldest-first scorePct
  childHistory: number[]; // uncapped, oldest-first scorePct
}) {
  const youSide = toSide(youLabel, you, youHistory);
  const childSide = toSide(childLabel, child, childHistory);

  if (youHistory.length === 0 && childHistory.length === 0) {
    return null;
  }

  // Subjects either side has attempted, in stable SUBJECTS order.
  const subjects = SUBJECTS.filter(
    (s) => youSide.summaries.has(s.id) || childSide.summaries.has(s.id),
  );

  return (
    <section className="progress-view">
      <p className="eyebrow">You vs {childLabel}</p>

      <div className="compare-totals">
        {[youSide, childSide].map((side) => (
          <div className="compare-col" key={side.label}>
            <p className="compare-col-name">{side.label}</p>
            <div className="summary-stats">
              <div className="stat">
                <span className="stat-num">{side.history.length}</span>
                <span className="stat-label">Attempts</span>
              </div>
              <div className="stat">
                <span className="stat-num">{overallAverage(side.history)}%</span>
                <span className="stat-label">Average</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {subjects.length > 0 && (
        <div className="compare-subjects">
          <p className="compare-subhead">Recent by subject (average %)</p>
          <div className="compare-srow compare-srow-head">
            <span className="compare-srow-name" />
            <span className="compare-srow-val">{youLabel}</span>
            <span className="compare-srow-val">{childLabel}</span>
          </div>
          {subjects.map((s) => {
            const yours = youSide.summaries.get(s.id);
            const theirs = childSide.summaries.get(s.id);
            return (
              <div className="compare-srow" key={s.id}>
                <span className="compare-srow-name">{s.label}</span>
                <span className="compare-srow-val">{yours ? `${yours.average}%` : '—'}</span>
                <span className="compare-srow-val">{theirs ? `${theirs.average}%` : '—'}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="compare-progression">
        <p className="compare-subhead">Score by attempt number</p>
        <Progression label={youLabel} history={youHistory} />
        <Progression label={childLabel} history={childHistory} />
      </div>
    </section>
  );
}
