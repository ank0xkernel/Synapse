import { api, idParam, notFound } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { one, query } from '@/lib/db';

export const POST = api<{ id: string }>(async (_req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  if (!(await one('SELECT 1 FROM resumes WHERE user_id = $1 AND id = $2', [user.id, id]))) throw notFound();
  // Two steps: the partial unique index allows only one active row, checked per row.
  await query('UPDATE resumes SET is_active = false WHERE user_id = $1 AND is_active AND id <> $2', [user.id, id]);
  await query('UPDATE resumes SET is_active = true, updated_at = now() WHERE user_id = $1 AND id = $2', [user.id, id]);
  return {};
});
