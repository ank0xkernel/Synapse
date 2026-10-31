import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { listSessions } from '@/lib/data';
import { fmtDate, fmtDateTime, STATUS_LABEL, STATUS_TONE } from '@/lib/format';

export const metadata: Metadata = { title: 'Sessions' };

export default async function Sessions() {
  const user = await requirePageUser();
  const sessions = await listSessions(user.id);
  return (
    <div className="stack-lg">
      <div className="row-between page-head" style={{ flexDirection: 'row' }}>
        <div className="stack" style={{ gap: 4 }}>
          <h1>Sessions</h1>
          <p>One session per interview: which resume, which job, how you want answers, and your own notes.</p>
        </div>
        <Link className="btn btn-primary" href="/sessions/new">New session</Link>
      </div>
      {sessions.length === 0 ? (
        <div className="empty"><p>No sessions yet.</p><Link className="btn btn-primary" href="/sessions/new">Create your first session</Link></div>
      ) : (
        <div className="card">
          <ul className="list">
            {sessions.map((s) => (
              <li key={s.id}>
                <div className="grow stack" style={{ gap: 2 }}>
                  <Link className="title" href={`/sessions/${s.id}`}>{s.title}</Link>
                  <span className="meta">
                    {[s.role, s.company].filter(Boolean).join(' at ') || 'No role set'} - {s.resume_name ?? 'no resume'} - {s.jd_label ?? 'no job description'}
                  </span>
                  <span className="meta">{s.scheduled_at ? `Scheduled ${fmtDateTime(s.scheduled_at)}` : `Updated ${fmtDate(s.updated_at)}`}</span>
                </div>
                {user.activeSessionId === s.id && <span className="status" data-tone="accent">Loaded by desktop</span>}
                <span className="status" data-tone={STATUS_TONE[s.status] === 'neutral' ? undefined : STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
