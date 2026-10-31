import { api, idParam, notFound, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { one } from '@/lib/db';
import { assertOwnedOrNull } from '@/lib/owned';
import { sessionBody } from '@/lib/schemas';

type P = { id: string };

export const PATCH = api<P>(async (req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  const b = await readJson(req, sessionBody, 64 * 1024);
  await assertOwnedOrNull('resumes', user.id, b.resumeId);
  await assertOwnedOrNull('job_descriptions', user.id, b.jdId);
  const row = await one(
    `UPDATE interview_sessions SET resume_id=$3, jd_id=$4, title=$5, company=$6, role=$7, interview_type=$8, response_mode=$9,
       notes=$10, status=$11, scheduled_at=$12, updated_at=now()
     WHERE user_id=$1 AND id=$2 RETURNING id`,
    [user.id, id, b.resumeId, b.jdId, b.title, b.company, b.role, b.interviewType, b.responseMode, b.notes, b.status, b.scheduledAt]
  );
  if (!row) throw notFound();
  return {};
});

export const DELETE = api<P>(async (_req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  if (!(await one('DELETE FROM interview_sessions WHERE user_id = $1 AND id = $2 RETURNING id', [user.id, id]))) throw notFound();
  return {};
});
