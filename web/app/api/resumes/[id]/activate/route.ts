import { api, idParam, notFound } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { withTx } from '@/lib/db';

export const POST = api<{ id: string }>(async (_req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  await withTx(async (q) => {
    await q('SELECT pg_advisory_xact_lock(hashtext($1))', [`resumes:${user.id}`]);
    const [row] = await q<{ id: string }>('SELECT id FROM resumes WHERE user_id = $1 AND id = $2', [user.id, id]);
    if (!row) throw notFound();
    // Two steps inside atomic transaction: the partial unique index allows only one active row
    await q('UPDATE resumes SET is_active = false WHERE user_id = $1 AND is_active AND id <> $2', [user.id, id]);
    await q('UPDATE resumes SET is_active = true, updated_at = now() WHERE user_id = $1 AND id = $2', [user.id, id]);
  });
  return {};
});
