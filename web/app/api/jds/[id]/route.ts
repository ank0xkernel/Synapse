import { api, idParam, notFound, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { one } from '@/lib/db';
import { parseJd } from '@/lib/jd';
import { assertOwnedOrNull } from '@/lib/owned';
import { jdBody } from '@/lib/schemas';

type P = { id: string };

export const PATCH = api<P>(async (req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  const b = await readJson(req, jdBody, 100 * 1024);
  await assertOwnedOrNull('resumes', user.id, b.resumeId);
  const row = await one(
    `UPDATE job_descriptions SET company = $3, role = $4, text = $5, parsed = $6, resume_id = $7, response_mode = $8, updated_at = now()
     WHERE user_id = $1 AND id = $2 RETURNING id`,
    [user.id, id, b.company, b.role, b.text, JSON.stringify(parseJd(b.text)), b.resumeId, b.responseMode]
  );
  if (!row) throw notFound();
  return {};
});

export const DELETE = api<P>(async (_req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  if (!(await one('DELETE FROM job_descriptions WHERE user_id = $1 AND id = $2 RETURNING id', [user.id, id]))) throw notFound();
  return {};
});
