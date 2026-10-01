import { notFound } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { isSoloMode } from '@/lib/env';
import { SoloStart } from './SoloStart';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Open your learning space' };

export default async function SoloStartPage() {
  if (!isSoloMode()) notFound();
  const session = await getSession();
  // Clear the fragment client-side before navigation. A server redirect can
  // inherit the launch fragment onto the destination URL in the browser.
  return <SoloStart active={Boolean(session.userId)} />;
}
