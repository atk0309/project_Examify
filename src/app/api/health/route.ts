import { NextResponse } from 'next/server';
import { UnsafeDataDirError } from '@/lib/data-dir';
import { DatabaseMissingError, db, schema } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Reason codes only — never `error.message` (it can carry a filesystem path). */
type HealthFailure = 'unsafe_data_dir' | 'db_missing' | 'db_error';

function failureReason(error: unknown): HealthFailure {
  if (error instanceof UnsafeDataDirError) return 'unsafe_data_dir';
  if (error instanceof DatabaseMissingError) return 'db_missing';
  return 'db_error';
}

export async function GET(): Promise<NextResponse> {
  try {
    // Touch the DB so we surface broken-volume / broken-migration states.
    db.select({ id: schema.users.id }).from(schema.users).limit(1).all();
    return NextResponse.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, reason: failureReason(error) }, { status: 503 });
  }
}
