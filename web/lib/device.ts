import 'server-only';
import crypto from 'node:crypto';
import { one, query } from './db';
import { sha256 } from './auth';
import { ApiError } from './http';

export const TOKEN_DAYS = 90;

/** Creates a device token. Only its sha256 is stored; the plaintext is returned to the caller once. */
export async function issueDeviceToken(userId: string, name: string, via: 'manual' | 'pkce') {
  const token = `syn_${crypto.randomBytes(32).toString('base64url')}`;
  if (via === 'pkce') {
    // Re-linking the same desktop replaces its previous credential.
    await query(`UPDATE device_tokens SET revoked_at = now() WHERE user_id = $1 AND name = $2 AND linked_via = 'pkce' AND revoked_at IS NULL`, [userId, name]);
  }
  const row = await one<{ id: string; expires_at: Date }>(
    `INSERT INTO device_tokens (user_id, name, token_hash, prefix, linked_via, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) RETURNING id, expires_at`,
    [userId, name, sha256(token), token.slice(0, 8), via, TOKEN_DAYS]
  );
  return { id: row!.id, token, expiresAt: row!.expires_at };
}

export interface DeviceAuth {
  tokenId: string;
  userId: string;
}

/** Bearer device-token auth. Cookies are never consulted. Each use slides the 90-day expiry. */
export async function requireDevice(req: Request): Promise<DeviceAuth> {
  const m = /^Bearer (syn_[A-Za-z0-9_-]{20,100})$/.exec(req.headers.get('authorization') || '');
  const fail = new ApiError(401, 'Invalid, expired or revoked device token', { 'WWW-Authenticate': 'Bearer' });
  if (!m) throw fail;
  const row = await one<{ id: string; user_id: string }>(
    `UPDATE device_tokens SET last_used_at = now(), expires_at = now() + make_interval(days => $2)
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING id, user_id`,
    [sha256(m[1]), TOKEN_DAYS]
  );
  if (!row) throw fail;
  return { tokenId: row.id, userId: row.user_id };
}
