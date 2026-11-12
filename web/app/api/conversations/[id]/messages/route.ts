import { z } from 'zod';
import { api, idParam, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { sendMessage } from '@/lib/chat';

export const maxDuration = 60;

const body = z.object({ id: z.string().uuid(), content: z.string().trim().min(1).max(20_000) });

/** Send a message and get the AI reply. Retrying with the same message id never duplicates either side. */
export const POST = api<{ id: string }>(async (req, { params }) => {
  const user = await requireUser();
  const conversationId = idParam((await params).id);
  const b = await readJson(req, body, 64 * 1024);
  return sendMessage(user.id, { conversationId, messageId: b.id, content: b.content });
});
