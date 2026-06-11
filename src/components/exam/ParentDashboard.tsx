'use client';

/* ============================================================================
   EXAMIFY — PARENT DASHBOARD
   Parents land here instead of the exam flow. It renders the child's progress
   (read-only), the parent's own progress, and a comparison of the two — plus
   the entry into "student mode" (the "Are you smarter than your kid?"
   flow), where the parent takes the exams themselves. The child's record stays
   bound to the student; a parent's attempts accumulate under the parent's id.
   ========================================================================== */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setStudentMode } from '@/actions/toggleStudentMode';
import { signOut } from '@/actions/signOut';
import type { ProgressData } from '@/lib/exam/attempts';
import { ComparisonView } from './ComparisonView';
import { ProgressView } from './ProgressView';
import { UIcon } from './icons';

const YOU_LABEL = 'You';

export function ParentDashboard({
  childLabel,
  childProgress,
  ownProgress,
  childHistory,
  ownHistory,
}: {
  childLabel: string;
  childProgress: ProgressData;
  ownProgress: ProgressData;
  childHistory: number[];
  ownHistory: number[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const enterStudentMode = () => {
    startTransition(async () => {
      await setStudentMode(true);
      router.refresh();
    });
  };

  return (
    <div className="stage">
      <div className="app-frame">
        <div className="screen">
          <header className="topbar">
            <span className="topbar-spacer" />
            <span className="topbar-label">Parent</span>
            <span className="topbar-spacer" />
            <form action={signOut}>
              <button className="topbar-btn" type="submit" aria-label="Sign out" title="Sign out">
                {UIcon.signout}
              </button>
            </form>
          </header>
          <div className="hero">
            <p className="eyebrow">Progress</p>
            <h1 className="display-title">{childLabel}&rsquo;s progress</h1>
            <p className="subtitle">
              A read-only view of {childLabel}&rsquo;s recent mini exams — and how you stack up.
            </p>
            <button
              className="btn btn-primary btn-cta"
              onClick={enterStudentMode}
              disabled={pending}
              type="button"
            >
              Are you smarter than your kid? {UIcon.arrow}
            </button>
          </div>

          <ComparisonView
            youLabel={YOU_LABEL}
            childLabel={childLabel}
            you={ownProgress}
            child={childProgress}
            youHistory={ownHistory}
            childHistory={childHistory}
          />

          <section className="progress-view">
            <p className="eyebrow">Your attempts</p>
            <ProgressView
              data={ownProgress}
              emptyHint="You haven't tried a mini exam yet — tap “Are you smarter…?” above to start."
            />
          </section>

          <section className="progress-view">
            <p className="eyebrow">{childLabel}&rsquo;s attempts</p>
            <ProgressView
              data={childProgress}
              emptyHint={`No exams yet — once ${childLabel} finishes a mini exam, it'll show up here.`}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
