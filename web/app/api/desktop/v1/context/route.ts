import { NextResponse } from 'next/server';
import { api, ApiError, uuid } from '@/lib/http';
import { requireDevice } from '@/lib/device';
import { buildContextBundle } from '@/lib/data';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Desktop pulls this once before a live session. Bearer device token only; cookies are ignored. */
export const GET = api(async (req) => {
  const dev = await requireDevice(req);
  const sessionParam = new URL(req.url).searchParams.get('session');
  let sessionId: string | null = null;
  if (sessionParam !== null) {
    const r = uuid.safeParse(sessionParam);
    if (!r.success) throw new ApiError(404, 'Session not found');
    sessionId = r.data;
  }
  const out = await buildContextBundle(dev.userId, sessionId);
  if (out === 'session_not_found') throw new ApiError(404, 'Session not found');
  if (out === 'no_context') throw new ApiError(404, 'No active context. Create a session or activate a resume on the website.');

  // A 304 and a 200 both mean the desktop now holds this version.
  await query('UPDATE device_tokens SET context_version = $1, context_fetched_at = now() WHERE id = $2', [out.body.version, dev.tokenId]);
  const headers = { ETag: out.etag, 'Cache-Control': 'private, no-cache' };
  const inm = req.headers.get('if-none-match');
  if (inm && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).includes(out.etag)) return new NextResponse(null, { status: 304, headers });
  return NextResponse.json({ ok: true, etag: out.etag, ...out.body }, { headers });
}, { bearer: true });
