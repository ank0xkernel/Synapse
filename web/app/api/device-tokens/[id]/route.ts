import { api, idParam, notFound } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { one } from '@/lib/db';

export const DELETE = api<{ id: string }>(async (_req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  const row = await one('UPDATE device_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND id = $2 RETURNING id', [
    user.id,
    id
  ]);
  if (!row) throw notFound();
  return {};
});
