import Link from 'next/link';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getAiSettingsSnapshot, requireAiSettingsAdmin } from '@/lib/ai-settings';
import { AiSettings } from '@/components/exam/AiSettings';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'AI settings', robots: { index: false, follow: false } };

export default async function AiSettingsPage() {
  const session = await getSession();
  if (!session.userId) redirect('/signin');
  const gate = await requireAiSettingsAdmin();
  if (!gate.ok) redirect('/');
  let snapshot;
  try {
    snapshot = await getAiSettingsSnapshot(gate.householdId, true);
  } catch {
    return (
      <main className="stage">
        <section className="app-frame ai-settings-frame">
          <h1>AI settings unavailable</h1>
          <p role="alert">
            The host could not read its configuration. Check .env file permissions, then reload. No
            saved values are displayed.
          </p>
          <Link href="/">Back to dashboard</Link>
        </section>
      </main>
    );
  }
  return (
    <div className="stage">
      <div className="app-frame ai-settings-frame">
        <AiSettings snapshot={snapshot} />
      </div>
    </div>
  );
}
