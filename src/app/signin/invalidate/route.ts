import { redirect } from 'next/navigation';
import { getRawSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Persist a session-cookie clear. `getSession` redirects here when
 * household membership no longer matches the sealed cookie — cookie
 * mutation is illegal during a Server Component render (Next.js 16).
 */
export async function GET(): Promise<void> {
  const session = await getRawSession();
  session.destroy();
  redirect('/signin');
}
