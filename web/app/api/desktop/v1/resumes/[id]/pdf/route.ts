import { api, idParam } from '@/lib/http';
import { requireDevice } from '@/lib/device';
import { pdfResponse } from '@/lib/resume-file';

export const dynamic = 'force-dynamic';

export const GET = api<{ id: string }>(async (req, { params }) => {
  const dev = await requireDevice(req);
  return pdfResponse(dev.userId, idParam((await params).id));
}, { bearer: true });
