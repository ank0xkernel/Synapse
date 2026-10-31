import { api } from '@/lib/http';
import { requireDevice } from '@/lib/device';
import { query } from '@/lib/db';

/** Revokes the calling device token. */
export const POST = api(async (req) => {
  const dev = await requireDevice(req);
  await query('UPDATE device_tokens SET revoked_at = now() WHERE id = $1', [dev.tokenId]);
  return new Response(null, { status: 204 });
}, { bearer: true });
