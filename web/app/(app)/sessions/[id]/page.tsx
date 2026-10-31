import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageUser } from '@/lib/auth';
import { getSession, listJds, listResumes } from '@/lib/data';
import { uuid } from '@/lib/http';
import { fmtDate, STATUS_LABEL, STATUS_TONE } from '@/lib/format';
import SessionForm from '@/components/SessionForm';
import PostButton from '@/components/PostButton';
import ConfirmButton from '@/components/ConfirmButton';

export const metadata: Metadata = { title: 'Session' };

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const [s, resumes, jds] = await Promise.all([getSession(user.id, id), listResumes(user.id), listJds(user.id)]);
  if (!s) notFound();
  const isActive = user.activeSessionId === s.id;
  return (
    <div className="stack-lg">
      <div className="page-head">
        <p className="meta"><Link href="/sessions">Sessions</Link></p>
        <div className="row-between">
          <h1>{s.title}</h1>
          <div className="row">
            <span className="status" data-tone={STATUS_TONE[s.status] === 'neutral' ? undefined : STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</span>
            <Link className="btn" href={`/prep/${s.id}`}>Preparation</Link>
            {isActive ? <span className="status" data-tone="accent">Loaded by desktop</span> : <PostButton label="Load in desktop app" url={`/api/sessions/${s.id}/activate`} />}
            <ConfirmButton label="Delete" title="Delete this session?" body="The session and its saved preparation are permanently removed. Your resume and job description are kept." url={`/api/sessions/${s.id}`} redirectTo="/sessions" />
          </div>
        </div>
        <p className="meta">Created {fmtDate(s.created_at)} - last edited {fmtDate(s.updated_at)}</p>
      </div>
      <div className="card">
        <SessionForm
          initial={{ ...s, scheduled_at: s.scheduled_at ? s.scheduled_at.toISOString() : null }}
          defaultResumeId={null}
          resumes={resumes.map((r) => ({ id: r.id, name: r.name }))}
          jds={jds.map((j) => ({ id: j.id, company: j.company, role: j.role, label: [j.role, j.company].filter(Boolean).join(' at ') || 'Untitled' }))}
        />
      </div>
    </div>
  );
}
