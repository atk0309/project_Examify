import { redirect } from 'next/navigation';
import { ExamApp, type Resumable } from '@/components/exam/ExamApp';
import { ParentDashboard } from '@/components/exam/ParentDashboard';
import { getSession } from '@/lib/auth';
import { getAuthMode } from '@/lib/env';
import { getExamSessions } from '@/lib/exam-session';
import {
  canInvite,
  canRemoveMember,
  getMembershipForUser,
  labelFromEmail,
  listHouseholdMembers,
  listPendingInvites,
} from '@/lib/households';
import { getProgressForUser, getScoreHistory, resolveChildren } from '@/lib/progress';
import {
  adminNeedsOnboardingChip,
  adminShouldAutoStartOnboarding,
  getOnboardingForUser,
} from '@/lib/onboarding';
import { resolveExamPaper } from '@/lib/exam/data';
import type { HouseholdMemberView } from '@/lib/household-types';

/**
 * Reconstruct the user's resumable in-progress exams from their saved sessions.
 * A session whose paper can't be fully rebuilt (the bank was edited and dropped a
 * question since it was saved) is omitted rather than offered as a broken resume;
 * the stale row is harmless and gets upserted over on the next start. Read-only —
 * no DB mutation here (illegal during a Server Component render).
 */
function resumableFor(userId: number): Resumable[] {
  return getExamSessions(userId).flatMap((s) => {
    const questions = resolveExamPaper(s.subject, s.difficulty, s.questionIds);
    if (questions === null || s.answers.length !== questions.length) return [];
    return [
      {
        subject: s.subject,
        difficulty: s.difficulty,
        questions,
        answers: s.answers,
        currentIndex: s.currentIndex,
      },
    ];
  });
}

export default async function HomePage() {
  const session = await getSession();
  if (!session.userId || !session.role) {
    redirect('/signin');
  }

  if (session.role === 'parent') {
    const onboarding = getOnboardingForUser(session.userId);
    if (
      adminShouldAutoStartOnboarding({
        role: onboarding.role,
        onboardingComplete: onboarding.complete,
        state: onboarding.state,
      })
    ) {
      redirect('/onboarding');
    }
    const ownProgress = getProgressForUser(session.userId);

    // Student mode: the parent plays the exams themselves with full controls.
    // Strict `=== true` mirrors `recordAttempt`'s write gate, so a malformed
    // session can never route a parent into the exam UI the action would reject.
    if (session.studentMode === true) {
      return (
        <ExamApp
          role="parent"
          studentMode
          initialProgress={ownProgress}
          resumable={resumableFor(session.userId)}
        />
      );
    }

    // Otherwise the parent dashboard: every household student's progress, the
    // parent's own progress, and a comparison against a selected student.
    // Children are resolved from the parent's own household only.
    const kids = session.email ? resolveChildren(session.email) : [];
    const ownHistory = getScoreHistory(session.userId);
    const membership = getMembershipForUser(session.userId);
    const pendingInvites =
      membership && canInvite(session.userId) ? listPendingInvites(membership.householdId) : [];
    const members: HouseholdMemberView[] =
      membership && canInvite(session.userId)
        ? listHouseholdMembers(membership.householdId).map((row) => {
            const target = getMembershipForUser(row.userId);
            return {
              userId: row.userId,
              email: row.email,
              role: row.role,
              label: labelFromEmail(row.email),
              canRemove: Boolean(target && canRemoveMember(membership, target)),
            };
          })
        : [];
    return (
      <ParentDashboard
        students={kids.map((child) => ({
          id: child.id,
          label: child.label,
          progress: getProgressForUser(child.id),
          history: getScoreHistory(child.id),
        }))}
        ownProgress={ownProgress}
        ownHistory={ownHistory}
        pendingInvites={pendingInvites}
        members={members}
        canInvite={canInvite(session.userId)}
        authMode={getAuthMode()}
        needsOnboarding={adminNeedsOnboardingChip({
          role: onboarding.role,
          onboardingComplete: onboarding.complete,
        })}
      />
    );
  }

  const progress = getProgressForUser(session.userId);
  return (
    <ExamApp
      role={session.role}
      initialProgress={progress}
      resumable={resumableFor(session.userId)}
    />
  );
}
