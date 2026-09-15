import { NextResponse } from 'next/server';
import { requireOnboardingAdmin } from '@/lib/onboarding-admin';
import {
  isOnboardingGenerateCancelToken,
  requestOnboardingGenerateCancel,
} from '@/lib/onboarding-generate';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Mark a wizard generate cancel token without going through a Server Action.
 * Next.js queues Server Actions from the same client, so
 * `cancelOnboardingGenerateAction` would sit behind the in-flight
 * `generateOnboardingSubjectAction` and the IR write would already have
 * happened. This route is a separate HTTP request and can land in the
 * process-local Set while generateSubject is still running.
 *
 * Provider HTTP abort is still Ingestion's parallel PR.
 */
function isTrustedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(env.SITE_URL).origin;
  } catch {
    return false;
  }
}

async function readCancelToken(request: Request): Promise<string | null> {
  const contentType = request.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as { cancelToken?: unknown };
      return typeof body.cancelToken === 'string' ? body.cancelToken : null;
    }
    const form = await request.formData();
    const token = form.get('cancelToken');
    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isTrustedOrigin(request)) {
    return NextResponse.json({ ok: false, reason: 'forbidden' }, { status: 403 });
  }
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) {
    return NextResponse.json({ ok: false, reason: gate.reason }, { status: 403 });
  }
  const token = await readCancelToken(request);
  if (!token || !isOnboardingGenerateCancelToken(token)) {
    return NextResponse.json({ ok: false, reason: 'invalid' }, { status: 400 });
  }
  if (!requestOnboardingGenerateCancel(token)) {
    return NextResponse.json({ ok: false, reason: 'already_committed' }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
