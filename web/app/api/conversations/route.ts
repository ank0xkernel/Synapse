import { api } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { listConversations } from '@/lib/conversations';

export const dynamic = 'force-dynamic';

export const GET = api(async () => {
  const user = await requireUser();
  return { conversations: await listConversations(user.id) };
});
