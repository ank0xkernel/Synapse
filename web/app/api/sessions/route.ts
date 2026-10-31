import { api, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { one } from '@/lib/db';
import { assertOwnedOrNull } from '@/lib/owned';
import { sessionBody } from '@/lib/schemas';

export const POST = api(async (req) => {
  const user = await requireUser();
  const b = await readJson(req, sessionBody, 64 * 1024);
  await assertOwnedOrNull('resumes', user.id, b.resumeId);
  await assertOwnedOrNull('job_descriptions', user.id, b.jdId);
  const row = await one<{ id: string }>(
    `INSERT INTO interview_sessions (user_id, resume_id, jd_id, title, company, role, interview_type, response_mode, notes, status, scheduled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [user.id, b.resumeId, b.jdId, b.title, b.company, b.role, b.interviewType, b.responseMode, b.notes, b.status, b.scheduledAt]
  );
  return { id: row!.id };
});
