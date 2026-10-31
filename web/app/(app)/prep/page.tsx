import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { listSessions } from '@/lib/data';

export const metadata: Metadata = { title: 'Prep' };

export default async function PrepIndex() {
  const user = await requirePageUser();
  const sessions = (await listSessions(user.id)).filter((s) => s.status !== 'completed');
  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>Interview preparation</h1>
        <p>Preparation runs per session, using the resume and job description attached to it.</p>
      </div>
      {sessions.length === 0 ? (
        <div className="empty"><p>Create a session with a resume and a job description to prepare.</p><Link className="btn btn-primary" href="/sessions/new">New session</Link></div>
      ) : (
        <div className="card">
          <ul className="list">
            {sessions.map((s) => (
              <li key={s.id}>
                <div className="grow stack" style={{ gap: 2 }}>
                  <Link className="title" href={`/prep/${s.id}`}>{s.title}</Link>
                  <span className="meta">{s.resume_name ?? 'No resume'} - {s.jd_label ?? 'No job description'}</span>
                </div>
                {!(s.resume_id && s.jd_id) && <span className="status" data-tone="warning">Needs resume and job description</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
