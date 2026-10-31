import { z } from 'zod';
import { api, ApiError, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { one } from '@/lib/db';
import { issueDeviceToken } from '@/lib/device';

const body = z.object({ name: z.string().trim().min(1).max(60) });

/** Manual token for tools that cannot use the browser sign-in. The plaintext is returned exactly once. */
export const POST = api(async (req) => {
  const user = await requireUser();
  const { name } = await readJson(req, body, 2048);
  const n = await one<{ n: string }>('SELECT count(*) AS n FROM device_tokens WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
  if (Number(n?.n) >= 10) throw new ApiError(400, 'Revoke an unused device first (limit 10)');
  const t = await issueDeviceToken(user.id, name, 'manual');
  return { id: t.id, token: t.token, expires_at: t.expiresAt.toISOString() };
});
