import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { countOf, getActiveResume, getSession, listSessions } from '@/lib/data';
import { fmtDateTime, STATUS_LABEL, STATUS_TONE } from '@/lib/format';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function Dashboard() {
  const user = await requirePageUser();
  const [resumes, jds, sessions, active, activeSession, recent] = await Promise.all([
    countOf('resumes', user.id),
    countOf('job_descriptions', user.id),
    countOf('interview_sessions', user.id),
    getActiveResume(user.id),
    user.activeSessionId ? getSession(user.id, user.activeSessionId) : null,
    listSessions(user.id)
  ]);
  const upcoming = recent.filter((s) => s.scheduled_at && s.status !== 'completed' && new Date(s.scheduled_at) > new Date()).reverse().slice(0, 3);

  const steps = [
    { done: resumes > 0, label: 'Upload a resume', href: '/resumes' },
    { done: jds > 0, label: 'Add a job description', href: '/jobs/new' },
    { done: sessions > 0, label: 'Create an interview session', href: '/sessions/new' },
    { done: !!activeSession, label: 'Choose the session for the desktop app', href: '/sessions' }
  ];

  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>Welcome{user.name ? `, ${user.name}` : ''}</h1>
        <p>Everything the desktop app needs for your next interview.</p>
      </div>

      <div className="grid-3">
        <div className="card stat"><span className="muted">Resumes</span><b>{resumes}</b></div>
        <div className="card stat"><span className="muted">Job descriptions</span><b>{jds}</b></div>
        <div className="card stat"><span className="muted">Sessions</span><b>{sessions}</b></div>
      </div>

      <div className="grid-2">
        <section className="card" aria-labelledby="setup">
          <h2 id="setup">Setup</h2>
          <ul className="list">
            {steps.map((s) => (
              <li key={s.label}>
                <span className="status" data-tone={s.done ? 'positive' : undefined}>{s.done ? 'Done' : 'To do'}</span>
                <Link className="title" href={s.href}>{s.label}</Link>
              </li>
            ))}
          </ul>
        </section>
        <section className="card stack" aria-labelledby="active">
          <h2 id="active">Active context</h2>
          <div>
            <p className="meta">Active resume</p>
            {active ? <Link className="title" href={`/resumes/${active.id}`}>{active.name}</Link> : <p className="muted">None yet</p>}
          </div>
          <div>
            <p className="meta">Session loaded by the desktop app</p>
            {activeSession ? <Link className="title" href={`/sessions/${activeSession.id}`}>{activeSession.title}</Link> : <p className="muted">None selected. The desktop app falls back to your active resume.</p>}
          </div>
        </section>
      </div>

      <section className="card" aria-labelledby="upc">
        <div className="row-between"><h2 id="upc">Upcoming interviews</h2><Link href="/sessions">All sessions</Link></div>
        {upcoming.length === 0 ? (
          <p className="muted">No scheduled interviews. Add a date when you create or edit a session.</p>
        ) : (
          <ul className="list">
            {upcoming.map((s) => (
              <li key={s.id}>
                <Link className="title grow" href={`/sessions/${s.id}`}>{s.title}</Link>
                <span className="meta">{fmtDateTime(s.scheduled_at!)}</span>
                <span className="status" data-tone={STATUS_TONE[s.status] === 'neutral' ? undefined : STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
