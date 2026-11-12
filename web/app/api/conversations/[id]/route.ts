import { z } from 'zod';
import { api, idParam, notFound, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { deleteConversation, getConversation, renameConversation } from '@/lib/conversations';

type P = { id: string };
export const dynamic = 'force-dynamic';

export const GET = api<P>(async (_req, { params }) => {
  const user = await requireUser();
  const found = await getConversation(user.id, idParam((await params).id));
  if (!found) throw notFound();
  return found;
});

const patch = z.object({ title: z.string().trim().min(1).max(200).optional(), summary: z.string().max(4000).optional() });

export const PATCH = api<P>(async (req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  return { conversation: await renameConversation(user.id, id, await readJson(req, patch, 16 * 1024)) };
});

export const DELETE = api<P>(async (_req, { params }) => {
  const user = await requireUser();
  await deleteConversation(user.id, idParam((await params).id));
  return {};
});
