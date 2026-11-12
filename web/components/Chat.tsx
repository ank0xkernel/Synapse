'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { call } from '@/lib/client';
import ConfirmButton from './ConfirmButton';
import s from '@/app/(app)/conversations/conversations.module.css';

interface Msg {
  id: string;
  role: 'user' | 'assistant' | 'transcript' | 'screen';
  content: string;
  created_at: string;
  meta: Record<string, unknown>;
  // Client-only: a sent message whose reply has not arrived.
  state?: 'sending' | 'failed';
  error?: string;
}

const LABEL: Record<Msg['role'], string> = { user: 'You', assistant: 'Synapse', transcript: 'Transcript', screen: 'Screen' };
const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Merge server rows into local state by id; local unsent messages stay until the server has them. */
function merge(local: Msg[], server: Msg[]): Msg[] {
  const byId = new Map(server.map((m) => [m.id, m]));
  const pending = local.filter((m) => m.state && !byId.has(m.id));
  return [...server, ...pending];
}

export default function Chat(props: { id: string; isNew: boolean; title: string; initial: Msg[] }) {
  const [messages, setMessages] = useState<Msg[]>(props.initial);
  const [title, setTitle] = useState(props.title);
  const [stored, setStored] = useState(!props.isNew);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [notice, setNotice] = useState('');
  const busy = messages.some((m) => m.state === 'sending');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [messages.length]);

  // The desktop may add to this conversation: refresh when the tab regains focus and every 20 s while visible.
  useEffect(() => {
    if (!stored) return;
    let stop = false;
    async function refresh() {
      if (document.visibilityState !== 'visible') return;
      const r = await call<{ conversation: { title: string }; messages: Msg[] }>('GET', `/api/conversations/${props.id}`, undefined, { timeoutMs: 15_000 });
      if (stop) return;
      if (r.ok) {
        setMessages((local) => merge(local, r.messages));
        setTitle((t) => (renaming ? t : r.conversation.title));
        setNotice('');
      } else if (r.error === 'Not found') {
        setNotice('This conversation was deleted on another device.');
      } else {
        setNotice(`Could not refresh: ${r.error} Showing what was loaded earlier.`);
      }
    }
    const timer = setInterval(refresh, 20_000);
    window.addEventListener('focus', refresh);
    return () => { stop = true; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [stored, props.id, renaming]);

  async function send(msg: Msg) {
    setMessages((m) => [...m.filter((x) => x.id !== msg.id), { ...msg, state: 'sending', error: undefined }]);
    const r = await call<{ conversation: { title: string }; reply: Msg }>('POST', `/api/conversations/${props.id}/messages`, { id: msg.id, content: msg.content }, { timeoutMs: 70_000 });
    if (r.ok) {
      setMessages((m) => [...m.map((x) => (x.id === msg.id ? { ...x, state: undefined } : x)).filter((x) => x.id !== r.reply.id), r.reply]);
      if (!stored) {
        setStored(true);
        setTitle(r.conversation.title);
        window.history.replaceState(null, '', `/conversations/${props.id}`);
      }
      return;
    }
    // A 503/502 still stored the user's message; the conversation exists from here on.
    if (!stored && /saved/i.test(r.error)) {
      setStored(true);
      window.history.replaceState(null, '', `/conversations/${props.id}`);
    }
    setMessages((m) => m.map((x) => (x.id === msg.id ? { ...x, state: 'failed', error: r.error } : x)));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setDraft('');
    void send({ id: crypto.randomUUID(), role: 'user', content, created_at: new Date().toISOString(), meta: {} });
  }

  async function rename(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next = String(new FormData(e.currentTarget).get('title') || '').trim();
    if (!next) return;
    const r = await call('PATCH', `/api/conversations/${props.id}`, { title: next });
    if (!r.ok) return setNotice(r.error);
    setTitle(next);
    setRenaming(false);
  }

  return (
    <div className="stack-lg">
      <div className="page-head page-head-row">
        <div className="stack-tight">
          <Link className="crumb" href="/conversations">Conversations</Link>
          {renaming ? (
            <form className={s.titleForm} onSubmit={rename}>
              <label className="sr-only" htmlFor="conv-title">Title</label>
              <input id="conv-title" name="title" className="input" defaultValue={title} maxLength={200} autoFocus />
              <button className="btn btn-primary btn-sm" type="submit">Save</button>
              <button className="btn btn-sm" type="button" onClick={() => setRenaming(false)}>Cancel</button>
            </form>
          ) : (
            <h1>{title || (stored ? 'Untitled conversation' : 'New conversation')}</h1>
          )}
        </div>
        {stored && !renaming && (
          <div className="row">
            <button className="btn btn-sm" type="button" onClick={() => setRenaming(true)}>Rename</button>
            <ConfirmButton small label="Delete" title="Delete this conversation?" body="It is removed from this website and from every linked desktop on their next sync. This cannot be undone." url={`/api/conversations/${props.id}`} redirectTo="/conversations" />
          </div>
        )}
      </div>

      {notice && <p className="notice" role="status">{notice}</p>}

      <section className={s.thread} aria-label="Messages" aria-live="polite">
        {messages.length === 0 && <p className="muted">Ask anything. Messages are saved to your account as you send them.</p>}
        {messages.map((m) => (
          <article key={m.id} className={s.msg} data-role={m.role}>
            <div className={s.msgMeta}>
              <span>{LABEL[m.role]}{m.meta.interrupted ? ' (interrupted)' : ''}</span>
              <time dateTime={m.created_at}>{time.format(new Date(m.created_at))}</time>
            </div>
            <div className={s.bubble}>{m.content}</div>
            {m.state === 'sending' && <p className={s.msgMeta} role="status">Waiting for the reply...</p>}
            {m.state === 'failed' && (
              <div className={s.msgMeta}>
                <span className="form-error" role="alert">{m.error}</span>
                <button className="btn btn-sm" type="button" onClick={() => send(m)}>Retry</button>
              </div>
            )}
          </article>
        ))}
        <div ref={endRef} />
      </section>

      <form className={s.composer} onSubmit={submit}>
        <label className="sr-only" htmlFor="composer">Message</label>
        <textarea
          id="composer"
          className="textarea"
          value={draft}
          maxLength={20_000}
          placeholder="Message Synapse"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e); }}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !draft.trim()}>{busy ? 'Sending...' : 'Send'}</button>
      </form>
    </div>
  );
}
