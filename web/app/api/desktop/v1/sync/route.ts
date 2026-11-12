import { api, ApiError, readJson } from '@/lib/http';
import { requireDevice } from '@/lib/device';
import { applyPush, decodeCursor, pull, pushInput } from '@/lib/conversations';

export const dynamic = 'force-dynamic';

/** Changes since `cursor` (docs/desktop-web-contract.md, section 5). */
export const GET = api(async (req) => {
  const dev = await requireDevice(req);
  const cursor = decodeCursor(new URL(req.url).searchParams.get('cursor'));
  if (!cursor) throw new ApiError(400, 'Invalid cursor; start over without one');
  return pull(dev.userId, cursor);
}, { bearer: true });

/** A batch of local changes. Idempotent, so the desktop resends after any failure. */
export const POST = api(async (req) => {
  const dev = await requireDevice(req);
  return applyPush(dev.userId, await readJson(req, pushInput, 4 * 1024 * 1024));
}, { bearer: true });
