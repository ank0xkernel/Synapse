import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageUser } from '@/lib/auth';
import { getSession, listJds, listResumes } from '@/lib/data';
import { uuid } from '@/lib/http';
import { fmtDate, fmtDateTime, STATUS_LABEL, STATUS_TONE } from '@/lib/format';
import { INTERVIEW_TYPES, RESPONSE_MODES } from '@/lib/constants';
import SessionForm from '@/components/SessionForm';
import PostButton from '@/components/PostButton';
import ConfirmButton from '@/components/ConfirmButton';
import Icon from '@/components/Icon';
import s from '../sessions.module.css';

export const metadata: Metadata = { title: 'Session' };

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const [sess, resumes, jds] = await Promise.all([getSession(user.id, id), listResumes(user.id), listJds(user.id)]);
  if (!sess) notFound();
  const isActive = user.activeSessionId === sess.id;
  const tone = STATUS_TONE[sess.status];
  const jd = sess.jd_id ? jds.find((j) => j.id === sess.jd_id) ?? null : null;
  // Mirrors buildContextBundle in lib/data: session values first, the job description fills blanks.
  const company = sess.company || jd?.company || '';
  const role = sess.role || jd?.role || '';
  const from = (own: string, v: string) => (v && !own ? <span className={s.from}>from the job description</span> : null);

  return (
    <div className="stack-lg">
      <div className="page-head">
        <p className="crumb"><Link href="/sessions">Sessions</Link></p>
        <div className="row-between">
          <h1>{sess.title}</h1>
          <div className="row">
            {isActive ? null : <PostButton label="Load in desktop app" url={`/api/sessions/${sess.id}/activate`} primary />}
            <Link className="btn" href={`/prep/${sess.id}`}>Preparation</Link>
            <ConfirmButton label="Delete" title="Delete this session?" body="The session and its saved preparation are permanently removed. Your resume and job description are kept." url={`/api/sessions/${sess.id}`} redirectTo="/sessions" />
          </div>
        </div>
        <div className={s.headStatus}>
          <span className="status" data-tone={tone === 'neutral' ? undefined : tone}>{STATUS_LABEL[sess.status]}</span>
          {isActive && <span className="status" data-tone="accent">Loaded by desktop</span>}
          <span>Created {fmtDate(sess.created_at)}</span>
          <span>Last edited {fmtDate(sess.updated_at)}</span>
        </div>
      </div>

      <div className={s.detail}>
        <section className={`card ${s.formCard}`} aria-labelledby="edit-h">
          <h2 id="edit-h">Edit session</h2>
          <SessionForm
            initial={{ ...sess, scheduled_at: sess.scheduled_at ? sess.scheduled_at.toISOString() : null }}
            defaultResumeId={null}
            resumes={resumes.map((r) => ({ id: r.id, name: r.name }))}
            jds={jds.map((j) => ({ id: j.id, company: j.company, role: j.role, label: [j.role, j.company].filter(Boolean).join(' at ') || 'Untitled' }))}
          />
        </section>

        <aside className={`${s.receives} ${isActive ? 'fringe' : ''}`} aria-labelledby="recv-h">
          <h2 id="recv-h"><Icon name="desktop" size={18} /> What the desktop receives</h2>
          <p>
            {isActive
              ? 'The desktop app loads this session. Before a call it fetches the saved values below.'
              : 'Not loaded. After you choose Load in desktop app, the desktop fetches the saved values below before a call.'}
          </p>
          <dl className={s.bundle}>
            <div><dt>Answer style</dt><dd>{RESPONSE_MODES.find((m) => m.id === sess.response_mode)?.label ?? sess.response_mode}</dd></div>
            <div><dt>Role</dt><dd data-missing={!role}>{role || 'Not set'}{from(sess.role, role)}</dd></div>
            <div><dt>Company</dt><dd data-missing={!company}>{company || 'Not set'}{from(sess.company, company)}</dd></div>
            <div><dt>Interview</dt><dd>{INTERVIEW_TYPES.find((t) => t.id === sess.interview_type)?.label ?? sess.interview_type}</dd></div>
            <div><dt>Scheduled</dt><dd data-missing={!sess.scheduled_at}>{sess.scheduled_at ? fmtDateTime(sess.scheduled_at) : 'Not scheduled'}</dd></div>
            <div>
              <dt>Resume</dt>
              <dd data-missing={!sess.resume_name}>
                {sess.resume_id && sess.resume_name ? <><Link href={`/resumes/${sess.resume_id}`}>{sess.resume_name}</Link><span className={s.from}>text and reviewed profile</span></> : 'None attached'}
              </dd>
            </div>
            <div><dt>Job</dt><dd data-missing={!jd}>{jd ? <Link href={`/jobs/${jd.id}`}>{sess.jd_label || 'Untitled'}</Link> : 'None attached'}</dd></div>
            <div><dt>Notes</dt><dd data-missing={!sess.notes}>{sess.notes ? <span className={s.notes}>{sess.notes}</span> : 'None'}</dd></div>
          </dl>
        </aside>
      </div>
    </div>
  );
}
