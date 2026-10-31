import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { getActiveResume, getProfile, getResume, listResumes } from '@/lib/data';
import { uuid } from '@/lib/http';
import ProfileEditor from '@/components/ProfileEditor';
import ConfirmButton from '@/components/ConfirmButton';

export const metadata: Metadata = { title: 'Profile' };

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ resume?: string }> }) {
  const user = await requirePageUser();
  const { resume: want } = await searchParams;
  const resumes = await listResumes(user.id);
  const resume = want && uuid.safeParse(want).success ? await getResume(user.id, want) : await getActiveResume(user.id);

  if (!resume) {
    return (
      <div className="stack-lg">
        <div className="page-head"><h1>Candidate profile</h1></div>
        <div className="empty">
          <p>Your profile is built from a resume. Upload one first.</p>
          <Link className="btn btn-primary" href="/resumes">Upload a resume</Link>
        </div>
      </div>
    );
  }
  const prof = await getProfile(user.id, resume.id);

  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>Candidate profile</h1>
        <p>Fields are extracted from your resume text without guessing. Anything the resume did not contain stays empty until you add it. Each field shows where it came from.</p>
      </div>
      <div className="row-between">
        <div className="row">
          {resumes.map((r) => (
            <Link key={r.id} className={`btn btn-sm${r.id === resume.id ? ' btn-primary' : ''}`} href={`/profile?resume=${r.id}`} aria-current={r.id === resume.id ? 'true' : undefined}>
              {r.name}
            </Link>
          ))}
        </div>
        <ConfirmButton small method="POST" label="Re-extract profile" title="Re-extract from resume text?" body="All fields are rebuilt from the resume text. Your edits to this profile will be replaced." url={`/api/resumes/${resume.id}/profile`} payload={{ confirm: true }} />
      </div>
      {prof && <ProfileEditor key={`${resume.id}-${prof.updated_at.toISOString()}`} resumeId={resume.id} initial={prof.profile} />}
    </div>
  );
}
