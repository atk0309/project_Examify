'use server';

import { redirect } from 'next/navigation';
import { destroySession } from '@/lib/auth';

/** Clear the session and return to the login screen. */
export async function signOut(): Promise<void> {
  await destroySession();
  redirect('/signin');
}
