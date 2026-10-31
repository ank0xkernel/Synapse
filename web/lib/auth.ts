import 'server-only';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { one, query } from './db';
import { ApiError } from './http';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

const COOKIE = 'synapse_session';
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const LOGIN_WINDOW_MIN = 15;
const LOGIN_MAX_FAILURES = 5;
const SIGNUP_MAX_PER_HOUR = 10;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  activeSessionId: string | null;
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// Used when the email is unknown so the response time does not reveal which emails exist.
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get('x-forwarded-for')?.split(',')[0] || h.get('x-real-ip') || 'unknown').trim().slice(0, 64);
}

function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production' && !process.env.INSECURE_COOKIES,
    path: '/',
    expires
  };
}

async function startSession(userId: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  const ua = ((await headers()).get('user-agent') || '').slice(0, 200);
  await query('INSERT INTO auth_sessions (user_id, token_hash, user_agent, expires_at) VALUES ($1, $2, $3, $4)', [
    userId,
    sha256(token),
    ua,
    expires
  ]);
  (await cookies()).set(COOKIE, token, cookieOptions(expires));
}

export async function signup(email: string, name: string, password: string): Promise<SessionUser> {
  const ip = await clientIp();
  const recent = await one<{ n: string }>(
    `SELECT count(*) AS n FROM login_attempts WHERE email = '__signup__' AND ip = $1 AND created_at > now() - interval '1 hour'`,
    [ip]
  );
  if (Number(recent?.n) >= SIGNUP_MAX_PER_HOUR) throw new ApiError(429, 'Too many sign-ups from this network. Try again later.');
  await query(`INSERT INTO login_attempts (email, ip, succeeded) VALUES ('__signup__', $1, true)`, [ip]);

  const hash = await hashPassword(password);
  const rows = await query<{ id: string }>(
    'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id',
    [email, name, hash]
  );
  if (!rows[0]) throw new ApiError(409, 'An account with that email already exists');
  await startSession(rows[0].id);
  return { id: rows[0].id, email, name, activeSessionId: null };
}

export async function login(email: string, password: string): Promise<SessionUser> {
  const ip = await clientIp();
  await query(`DELETE FROM login_attempts WHERE created_at < now() - interval '1 day'`);
  const fails = await one<{ n: string; oldest: Date | null }>(
    `SELECT count(*) AS n, min(created_at) AS oldest FROM login_attempts
     WHERE email = $1 AND ip = $2 AND succeeded = false AND created_at > now() - make_interval(mins => $3)`,
    [email, ip, LOGIN_WINDOW_MIN]
  );
  if (Number(fails?.n) >= LOGIN_MAX_FAILURES) {
    const retry = Math.max(1, Math.ceil((LOGIN_WINDOW_MIN * 60_000 - (Date.now() - new Date(fails!.oldest!).getTime())) / 1000));
    throw new ApiError(429, `Too many failed attempts. Try again in ${Math.ceil(retry / 60)} minute(s).`, { 'Retry-After': String(retry) });
  }

  const user = await one<{ id: string; name: string; password_hash: string; active_session_id: string | null }>(
    'SELECT id, name, password_hash, active_session_id FROM users WHERE email = $1',
    [email]
  );
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  await query('INSERT INTO login_attempts (email, ip, succeeded) VALUES ($1, $2, $3)', [email, ip, !!user && ok]);
  if (!user || !ok) throw new ApiError(401, 'Incorrect email or password');
  await startSession(user.id);
  return { id: user.id, email, name: user.name, activeSessionId: user.active_session_id };
}

export async function logout() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await query('DELETE FROM auth_sessions WHERE token_hash = $1', [sha256(token)]);
  jar.set(COOKIE, '', { ...cookieOptions(new Date(0)), maxAge: 0 });
}

/** The signed-in user, from the server-side session row. Never from client input. */
export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token || token.length > 128) return null;
  const row = await one<{ id: string; email: string; name: string; active_session_id: string | null }>(
    `SELECT u.id, u.email, u.name, u.active_session_id
     FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  return row ? { id: row.id, email: row.email, name: row.name, activeSessionId: row.active_session_id } : null;
}

/** For API routes: 401 when signed out. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new ApiError(401, 'Sign in required');
  return user;
}

/** For pages: redirect when signed out. */
export async function requirePageUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}
