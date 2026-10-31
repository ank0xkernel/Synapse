import { NextResponse } from 'next/server';
import { ping } from '@/lib/db';
import { driver } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/** Liveness plus a database round trip. No secrets, no per-user data. */
export async function GET() {
  const dbOk = await ping();
  return NextResponse.json(
    { ok: dbOk, db: dbOk ? 'ok' : 'error', storage: driver(), version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.npm_package_version ?? 'dev' },
    { status: dbOk ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
  );
}
