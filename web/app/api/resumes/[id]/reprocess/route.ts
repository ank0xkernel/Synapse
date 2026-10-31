import { api, idParam } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { reprocessResume } from '@/lib/resume-file';
import { getResume } from '@/lib/data';

export const maxDuration = 60;

/** Re-extract the stored original and rebuild the profile. User-edited profile items are kept. */
export const POST = api<{ id: string }>(async (_req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  await reprocessResume(user.id, id);
  const r = await getResume(user.id, id);
  return { parse_status: r?.parse_status, text_chars: r?.text_chars };
});
