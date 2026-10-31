import { NextResponse } from 'next/server';
import { z } from 'zod';
import { api } from '@/lib/http';
import { sha256 } from '@/lib/auth';
import { one, query } from '@/lib/db';
import { issueDeviceToken } from '@/lib/device';
import { challengeOf, safeEqual } from '@/lib/pkce';
import { headers } from 'next/headers';

const body = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(20).max(100),
  code_verifier: z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/),
  redirect_uri: z.string().max(200),
  device_name: z.string().trim().min(1).max(60).default('Synapse Desktop')
});

const oauthError = (status: number, error: string, description: string) =>
  NextResponse.json({ error, error_description: description }, { status, headers: { 'Cache-Control': 'no-store' } });

const WINDOW_FAILURES = 20;

/** Desktop exchanges the one-time code for a device token. No cookies; OAuth-style errors. */
export const POST = api(async (req) => {
  const h = await headers();
  const ip = (h.get('x-forwarded-for')?.split(',')[0] || h.get('x-real-ip') || 'unknown').trim().slice(0, 64);
  const fails = await one<{ n: string }>(
    `SELECT count(*) AS n FROM login_attempts WHERE email = '__token__' AND ip = $1 AND succeeded = false AND created_at > now() - interval '15 minutes'`,
    [ip]
  );
  if (Number(fails?.n) >= WINDOW_FAILURES) return oauthError(429, 'slow_down', 'Too many failed attempts. Try again later.');

  let parsed: z.infer<typeof body>;
  try {
    const text = await req.text();
    if (text.length > 4096) throw new Error('large');
    const r = body.safeParse(JSON.parse(text));
    if (!r.success) throw new Error('shape');
    parsed = r.data;
  } catch {
    return oauthError(400, 'invalid_request', 'Expected JSON with grant_type, code, code_verifier, redirect_uri and optional device_name.');
  }

  // Claim first: a code works at most once, even if the verifier then turns out to be wrong.
  const claimed = await one<{ user_id: string; code_challenge: string; redirect_uri: string }>(
    `UPDATE auth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id, code_challenge, redirect_uri`,
    [sha256(parsed.code)]
  );
  const ok = !!claimed && safeEqual(claimed.redirect_uri, parsed.redirect_uri) && safeEqual(challengeOf(parsed.code_verifier), claimed.code_challenge);
  await query(`INSERT INTO login_attempts (email, ip, succeeded) VALUES ('__token__', $1, $2)`, [ip, ok]);
  if (!claimed || !ok) return oauthError(400, 'invalid_grant', 'The code is invalid, expired, already used, or does not match the verifier or redirect_uri.');

  const user = await one<{ id: string; email: string }>('SELECT id, email FROM users WHERE id = $1', [claimed.user_id]);
  const t = await issueDeviceToken(claimed.user_id, parsed.device_name, 'pkce');
  return NextResponse.json(
    { access_token: t.token, token_type: 'Bearer', account: { id: user!.id, email: user!.email }, expires_at: t.expiresAt.toISOString() },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}, { bearer: true });
