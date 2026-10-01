import { NextResponse } from 'next/server';
import { getRawSession } from '@/lib/auth';
import { env, isSoloMode } from '@/lib/env';
import { bootstrapSoloSession } from '@/lib/solo';
import { soloRequestAllowed } from '@/lib/solo-security';

export const dynamic = 'force-dynamic';

function reply(reason: string, status: number) {
  return NextResponse.json(
    { ok: false, reason },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

/** Bounded body: never put the launch capability in a query, redirect or log. */
async function readToken(request: Request): Promise<string | null> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 256) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed &&
      typeof parsed === 'object' &&
      'token' in parsed &&
      typeof parsed.token === 'string'
      ? parsed.token
      : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (!isSoloMode()) return reply('unavailable', 404);
  if (!soloRequestAllowed(request.headers, env, request.method)) return reply('forbidden', 403);
  try {
    const token = await readToken(request);
    if (token === null) return reply('invalid', 400);
    const result = bootstrapSoloSession(token);
    if (!result.ok) return reply(result.reason, result.reason === 'forbidden' ? 403 : 409);
    const session = await getRawSession();
    session.userId = result.identity.userId;
    session.email = result.identity.email;
    session.role = 'parent';
    session.studentMode = true;
    session.sessionVersion = result.identity.sessionVersion;
    session.solo = true;
    await session.save();
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // No raw SQLite paths, capabilities, or cookie material in error responses/logs.
    return reply('unavailable', 503);
  }
}
