import type { Metadata } from 'next';
import { requirePageUser } from '@/lib/auth';
import { getActiveResume, getJd, listJds, listResumes } from '@/lib/data';
import { uuid } from '@/lib/http';
import SessionForm from '@/components/SessionForm';

export const metadata: Metadata = { title: 'New session' };

export default async function NewSession({ searchParams }: { searchParams: Promise<{ jd?: string }> }) {
  const user = await requirePageUser();
  const { jd: jdId } = await searchParams;
  const [resumes, jds, active, preJd] = await Promise.all([
    listResumes(user.id),
    listJds(user.id),
    getActiveResume(user.id),
    jdId && uuid.safeParse(jdId).success ? getJd(user.id, jdId) : null
  ]);
  const prefill = preJd
    ? {
        title: [preJd.role, preJd.company].filter(Boolean).join(' at ') || '',
        company: preJd.company,
        role: preJd.role,
        interview_type: 'general',
        response_mode: preJd.response_mode,
        notes: '',
        status: 'draft',
        scheduled_at: null,
        resume_id: preJd.resume_id ?? active?.id ?? null,
        jd_id: preJd.id
      }
    : undefined;
  return (
    <div className="stack-lg">
      <div className="page-head"><h1>New session</h1></div>
      <div className="card">
        <SessionForm
          initial={prefill}
          defaultResumeId={active?.id ?? null}
          resumes={resumes.map((r) => ({ id: r.id, name: r.name }))}
          jds={jds.map((j) => ({ id: j.id, company: j.company, role: j.role, label: [j.role, j.company].filter(Boolean).join(' at ') || 'Untitled' }))}
        />
      </div>
    </div>
  );
}
