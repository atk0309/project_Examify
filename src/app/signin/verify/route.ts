import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';
import { consumeMagicToken, getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Magic-link entry point. This is a Route Handler (not a page) because clicking
 * the email link is a GET navigation that must *write* the session cookie, and
 * cookie mutation is only legal in a Route Handler / Server Action / middleware
 * — never during a Server Component render. Failures redirect to the sibling
 * error page (`./error`), which renders the human-readable copy.
 */
export async function GET(request: NextRequest): Promise<void> {
  const token = request.nextUrl.searchParams.get('token') ?? '';
  if (!token) redirect('/signin/verify/error?reason=missing');

  const result = consumeMagicToken(token);
  if (!result.ok) redirect(`/signin/verify/error?reason=${result.reason}`);

  const session = await getSession();
  session.userId = result.userId;
  session.role = result.role;
  session.email = result.email;
  // Start every verified sign-in on the role's home surface. Without this, a
  // parent who had previously entered student mode would land straight back in
  // ExamApp on their next sign-in (the flag would survive in the cookie).
  session.studentMode = false;
  await session.save();

  redirect('/');
}
