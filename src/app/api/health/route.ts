import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';

export const dynamic = 'force-dynamic';

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
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'unknown' },
      { status: 503 },
    );
  }
}
