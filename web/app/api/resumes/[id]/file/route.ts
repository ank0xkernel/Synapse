import { api, idParam } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { pdfResponse } from '@/lib/resume-file';

export const GET = api<{ id: string }>(async (_req, { params }) => {
  const user = await requireUser();
  return pdfResponse(user.id, idParam((await params).id));
});
