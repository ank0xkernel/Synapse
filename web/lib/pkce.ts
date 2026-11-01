import 'server-only';
import crypto from 'node:crypto';

export const CLIENT_ID = 'synapse-desktop';

export interface LinkRequest {
  redirect_uri: string;
  code_challenge: string;
  state: string;
}

/**
 * Validates an authorization request. The redirect_uri must be an RFC 8252 loopback address on a
 * non-privileged port with the exact path /callback, so the page can never redirect elsewhere.
 */
export function parseLinkRequest(p: Record<string, unknown>): { ok: true; req: LinkRequest } | { ok: false; error: string } {
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  if (s('client') !== CLIENT_ID) return { ok: false, error: 'Unknown client.' };
  const m = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/callback$/.exec(s('redirect_uri'));
  const port = m ? Number(m[1]) : 0;
  if (!m || port < 1024 || port > 65535) return { ok: false, error: 'redirect_uri must be http://127.0.0.1:<port>/callback with a port from 1024 to 65535.' };
  if (s('code_challenge_method') !== 'S256') return { ok: false, error: 'code_challenge_method must be S256.' };
  if (!/^[A-Za-z0-9_-]{43}$/.test(s('code_challenge'))) return { ok: false, error: 'code_challenge must be a base64url SHA-256 digest (43 characters).' };
  if (!/^[\x21-\x7e]{16,128}$/.test(s('state'))) return { ok: false, error: 'state must be 16 to 128 printable characters.' };
  return { ok: true, req: { redirect_uri: s('redirect_uri'), code_challenge: s('code_challenge'), state: s('state') } };
}

export const challengeOf = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url');

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Only same-site relative paths are allowed as a post-login destination. Control characters are
 * refused because URL parsing strips tabs and newlines, which turns "/\t/evil.com" into "//evil.com".
 */
export const safeNext = (v: unknown) =>
  typeof v === 'string' && v.length < 2000 && /^\/(?![/\\])[^\x00-\x1f\x7f]*$/.test(v) && new URL(v, 'https://x.invalid').origin === 'https://x.invalid'
    ? v
    : '/dashboard';
