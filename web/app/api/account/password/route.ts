import { z } from 'zod';
import { api, ApiError, readJson } from '@/lib/http';
import { hashPassword, requireUser, sha256, verifyPassword } from '@/lib/auth';
import { one, query } from '@/lib/db';
import { cookies } from 'next/headers';

const body = z.object({ current: z.string().min(1).max(200), next: z.string().min(10, 'must be at least 10 characters').max(200) });

/** Changes the password, signs out every other session and unlinks every desktop. */
export const POST = api(async (req) => {
  const user = await requireUser();
  const b = await readJson(req, body, 2048);
  const row = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!row || !(await verifyPassword(b.current, row.password_hash))) throw new ApiError(403, 'Current password is incorrect');
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(b.next)]);
  const keep = (await cookies()).get('synapse_session')?.value ?? '';
  await query('DELETE FROM auth_sessions WHERE user_id = $1 AND token_hash <> $2', [user.id, sha256(keep)]);
  // A desktop token slides its expiry on use, so without this a stolen link would outlive the reset.
  await query('UPDATE device_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
  return {};
});
