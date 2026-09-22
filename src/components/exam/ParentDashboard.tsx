'use client';

/* ============================================================================
   EXAMIFY — PARENT DASHBOARD
   Parents land here instead of the exam flow. It renders each household
   student's progress (read-only), the parent's own progress, and a comparison
   against a selected student — plus the entry into "student mode".
   ========================================================================== */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { setStudentMode } from '@/actions/toggleStudentMode';
import { signOut } from '@/actions/signOut';
import type { AuthMode } from '@/lib/auth-mode';
import type { ProgressData } from '@/lib/exam/attempts';
import { SUBJECTS, type Subject } from '@/lib/exam/data';
import type { HouseholdMemberView, PendingInvite } from '@/lib/household-types';
import { ComparisonView } from './ComparisonView';
import { HouseholdInvites } from './HouseholdInvites';
import { ProgressView } from './ProgressView';
import { UIcon } from './icons';

const YOU_LABEL = 'You';

export type ChildSnapshot = {
  id: number;
  label: string;
  progress: ProgressData;
  history: number[];
};

export function ParentDashboard({
  students,
  ownProgress,
  ownHistory,
  pendingInvites = [],
  members = [],
  canInvite = false,
  authMode,
  needsOnboarding = false,
  subjects = SUBJECTS,
}: {
  students: ChildSnapshot[];
  ownProgress: ProgressData;
  ownHistory: number[];
  pendingInvites?: PendingInvite[];
  members?: HouseholdMemberView[];
  canInvite?: boolean;
  authMode: AuthMode;
  needsOnboarding?: boolean;
  subjects?: readonly Subject[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState<number | null>(students[0]?.id ?? null);
  const selected = students.find((c) => c.id === selectedId) ?? students[0];
  const headline = students.length === 1 ? `${students[0]!.label}’s progress` : 'Your household';

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
            <h1 className="display-title">{headline}</h1>
            <p className="subtitle">
              {students.length === 0
                ? 'Invite a student to see their mini exams here — and how you stack up.'
                : students.length === 1
                  ? `A read-only view of ${students[0]!.label}’s recent mini exams — and how you stack up.`
                  : 'A read-only view of every student in this household — and how you stack up.'}
            </p>
            <button
              className="btn btn-primary btn-cta"
              onClick={enterStudentMode}
              disabled={pending}
              type="button"
            >
              Are you smarter than your kid? {UIcon.arrow}
            </button>
            {needsOnboarding ? (
              <Link
                href="/onboarding"
                className="onboarding-chip"
                data-testid="finish-content-setup"
              >
                Finish content setup
              </Link>
            ) : null}
          </div>

          {canInvite ? (
            <HouseholdInvites pending={pendingInvites} members={members} authMode={authMode} />
          ) : null}

          {students.length > 1 ? (
            <div className="role-seg" role="radiogroup" aria-label="Compare against">
              {students.map((child) => (
                <button
                  type="button"
                  key={child.id}
                  role="radio"
                  aria-checked={selected?.id === child.id}
                  className={'role-opt' + (selected?.id === child.id ? ' active' : '')}
                  onClick={() => setSelectedId(child.id)}
                >
                  {child.label}
                </button>
              ))}
            </div>
          ) : null}

          {selected ? (
            <ComparisonView
              youLabel={YOU_LABEL}
              childLabel={selected.label}
              you={ownProgress}
              child={selected.progress}
              youHistory={ownHistory}
              childHistory={selected.history}
              subjects={subjects}
            />
          ) : null}

          <section className="progress-view">
            <p className="eyebrow">Your attempts</p>
            <ProgressView
              data={ownProgress}
              subjects={subjects}
              emptyHint="You haven't tried a mini exam yet — tap “Are you smarter…?” above to start."
            />
          </section>

          {students.length === 0 ? (
            <section className="progress-view">
              <p className="eyebrow">Students</p>
              <ProgressView
                data={{ attempts: [], subjects: [] }}
                subjects={subjects}
                emptyHint="No students in this household yet — create an invite above."
              />
            </section>
          ) : (
            students.map((child) => (
              <section className="progress-view" key={child.id} data-testid="student-attempts">
                <p className="eyebrow">{child.label}’s attempts</p>
                <ProgressView
                  data={child.progress}
                  subjects={subjects}
                  emptyHint={`No exams yet — once ${child.label} finishes a mini exam, it'll show up here.`}
                />
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
