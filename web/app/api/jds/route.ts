import { api, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { one } from '@/lib/db';
import { parseJd } from '@/lib/jd';
import { jdBody } from '@/lib/schemas';
import { assertOwnedOrNull } from '@/lib/owned';

export const POST = api(async (req) => {
  const user = await requireUser();
  const b = await readJson(req, jdBody, 100 * 1024);
  await assertOwnedOrNull('resumes', user.id, b.resumeId);
  const row = await one<{ id: string }>(
    `INSERT INTO job_descriptions (user_id, company, role, text, parsed, resume_id, response_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [user.id, b.company, b.role, b.text, JSON.stringify(parseJd(b.text)), b.resumeId, b.responseMode]
  );
  return { id: row!.id };
});
