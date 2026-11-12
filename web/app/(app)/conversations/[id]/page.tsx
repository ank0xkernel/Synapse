import type { Metadata } from 'next';
import crypto from 'node:crypto';
import { notFound } from 'next/navigation';
import { requirePageUser } from '@/lib/auth';
import { getConversation } from '@/lib/conversations';
import { uuid } from '@/lib/http';
import Chat from '@/components/Chat';

export const metadata: Metadata = { title: 'Conversation' };
export const dynamic = 'force-dynamic';

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  // "new" gets an id now; the conversation is stored when the first message is sent, so no empty ones pile up.
  if (id === 'new') return <Chat key="new" id={crypto.randomUUID()} isNew title="" initial={[]} />;
  if (!uuid.safeParse(id).success) notFound();
  const found = await getConversation(user.id, id);
  if (!found) notFound();
  const initial = found.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, created_at: m.created_at.toISOString(), meta: m.meta }));
  return <Chat key={id} id={id} isNew={false} title={found.conversation.title} initial={initial} />;
}
