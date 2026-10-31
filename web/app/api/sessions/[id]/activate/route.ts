import { api, idParam, notFound } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { one, query } from '@/lib/db';

/** Marks this session as the one the desktop app loads by default. */
export const POST = api<{ id: string }>(async (_req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  if (!(await one('SELECT 1 FROM interview_sessions WHERE user_id = $1 AND id = $2', [user.id, id]))) throw notFound();
  await query('UPDATE users SET active_session_id = $2 WHERE id = $1', [user.id, id]);
  return {};
});
