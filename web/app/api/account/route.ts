import { z } from 'zod';
import { api, ApiError, readJson } from '@/lib/http';
import { logout, requireUser, verifyPassword } from '@/lib/auth';
import { one, query } from '@/lib/db';

export const PATCH = api(async (req) => {
  const user = await requireUser();
  const { name } = await readJson(req, z.object({ name: z.string().trim().max(100) }), 2048);
  await query('UPDATE users SET name = $2 WHERE id = $1', [user.id, name]);
  return {};
});

/** Deletes the account and, by cascade, every resume, file, profile, JD, session, prep result and token. */
export const DELETE = api(async (req) => {
  const user = await requireUser();
  const { password } = await readJson(req, z.object({ password: z.string().min(1).max(200) }), 2048);
  const row = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!row || !(await verifyPassword(password, row.password_hash))) throw new ApiError(403, 'Incorrect password');
  await query('DELETE FROM users WHERE id = $1', [user.id]);
  await logout();
  return {};
});
