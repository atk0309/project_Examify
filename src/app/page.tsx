import { redirect } from 'next/navigation';
import { ExamApp, type Resumable } from '@/components/exam/ExamApp';
import { ParentDashboard } from '@/components/exam/ParentDashboard';
import { getSession } from '@/lib/auth';
import { getExamSessions } from '@/lib/exam-session';
import { getProgressForUser, getScoreHistory, resolveChildren } from '@/lib/progress';
import { resolveExamPaper } from '@/lib/exam/data';
import type { ProgressData } from '@/lib/exam/attempts';

const EMPTY_PROGRESS: ProgressData = { attempts: [], subjects: [] };

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

    // Otherwise the parent dashboard: the child's progress, the parent's own
    // progress, and a comparison — plus the entry into student mode. The child
    // is resolved from the parent's own family in FAMILIES (never another
    // family's), keyed by the signed-in parent's email.
    const child = session.email ? resolveChildren(session.email)[0] : undefined;
    const childProgress = child ? getProgressForUser(child.id) : EMPTY_PROGRESS;
    const ownHistory = getScoreHistory(session.userId);
    const childHistory = child ? getScoreHistory(child.id) : [];
    return (
      <ParentDashboard
        childLabel={child?.label ?? 'Your child'}
        childProgress={childProgress}
        ownProgress={ownProgress}
        childHistory={childHistory}
        ownHistory={ownHistory}
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
