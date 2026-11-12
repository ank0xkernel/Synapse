import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { listConversations } from '@/lib/conversations';
import { fmtDateTime } from '@/lib/format';
import Icon from '@/components/Icon';
import s from './conversations.module.css';

export const metadata: Metadata = { title: 'Conversations' };
export const dynamic = 'force-dynamic';

export default async function Conversations() {
  const user = await requirePageUser();
  const items = await listConversations(user.id);
  return (
    <div className="stack-lg">
      <div className="page-head page-head-row">
        <div>
          <h1>Conversations</h1>
          <p>Chats from this website and from the desktop app, newest first. Both stay in sync through your account.</p>
        </div>
        <Link className="btn btn-primary" href="/conversations/new"><Icon name="plus" size={16} />New conversation</Link>
      </div>
      {items.length === 0 ? (
        <section className="card stack" aria-labelledby="conv-empty">
          <h2 id="conv-empty">No conversations yet</h2>
          <p className="muted">Start one here, or link the desktop app on the Desktop page: what you capture there shows up here after it syncs.</p>
          <div><Link className="btn btn-primary" href="/conversations/new"><Icon name="plus" size={16} />Start a conversation</Link></div>
        </section>
      ) : (
        <ul className={s.list}>
          {items.map((c) => (
            <li key={c.id}>
              <Link className={s.item} href={`/conversations/${c.id}`}>
                <span className={s.itemHead}>
                  <span className={s.itemTitle}>{c.title || 'Untitled conversation'}</span>
                  <span className={s.when}>{fmtDateTime(c.updated_at)}</span>
                </span>
                <span className={s.preview}>{c.last_message ?? 'No messages'}</span>
                <span className={s.when}>{c.message_count} message{c.message_count === 1 ? '' : 's'} · {c.source === 'desktop' ? 'from desktop' : 'from web'}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
