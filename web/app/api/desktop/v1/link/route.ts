import crypto from 'node:crypto';
import { z } from 'zod';
import { api, ApiError, readJson } from '@/lib/http';
import { requireUser, sha256 } from '@/lib/auth';
import { query } from '@/lib/db';
import { parseLinkRequest } from '@/lib/pkce';

const body = z.object({
  approve: z.boolean(),
  client: z.string().max(64),
  redirect_uri: z.string().max(200),
  code_challenge: z.string().max(100),
  code_challenge_method: z.string().max(10),
  state: z.string().max(200)
});

/** Browser consent step (cookie session + Origin check). Returns where to send the browser: the desktop's loopback listener. */
export const POST = api(async (req) => {
  const user = await requireUser();
  const b = await readJson(req, body, 4096);
  const parsed = parseLinkRequest(b);
  if (!parsed.ok) throw new ApiError(400, parsed.error);
  const { redirect_uri, code_challenge, state } = parsed.req;
  const url = new URL(redirect_uri);
  if (!b.approve) {
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('state', state);
    return { redirect: url.toString() };
  }
  const code = crypto.randomBytes(32).toString('base64url');
  await query(`DELETE FROM auth_codes WHERE expires_at < now() - interval '1 day'`);
  await query(
    `INSERT INTO auth_codes (code_hash, user_id, code_challenge, redirect_uri, expires_at) VALUES ($1, $2, $3, $4, now() + interval '120 seconds')`,
    [sha256(code), user.id, code_challenge, redirect_uri]
  );
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);
  return { redirect: url.toString() };
});
