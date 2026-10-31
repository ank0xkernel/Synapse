import { api } from '@/lib/http';
import { requireDevice } from '@/lib/device';
import { one } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = api(async (req) => {
  const dev = await requireDevice(req);
  const row = await one<{ id: string; email: string; name: string; created_at: Date; expires_at: Date }>(
    `SELECT u.id, u.email, t.name, t.created_at, t.expires_at FROM device_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
    [dev.tokenId]
  );
  return {
    account: { id: row!.id, email: row!.email },
    token: { name: row!.name, created_at: row!.created_at.toISOString(), expires_at: row!.expires_at.toISOString() }
  };
}, { bearer: true });
