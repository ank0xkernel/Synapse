import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { getActiveResume, getProfile, getResume, listResumes } from '@/lib/data';
import { uuid } from '@/lib/http';
import ProfileEditor from '@/components/ProfileEditor';
import ConfirmButton from '@/components/ConfirmButton';
import Icon from '@/components/Icon';
import s from './profile.module.css';

export const metadata: Metadata = { title: 'Profile' };

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ resume?: string }> }) {
  const user = await requirePageUser();
  const { resume: want } = await searchParams;
  const resumes = await listResumes(user.id);
  const resume = want && uuid.safeParse(want).success ? await getResume(user.id, want) : await getActiveResume(user.id);

  if (!resume) {
    return (
      <div className={s.page}>
        <header className="page-head"><h1 className={s.h1}>Candidate profile</h1></header>
        <section className={s.empty} aria-labelledby="empty-h">
          <div className={s.emptySheet} aria-hidden="true"><i /><i /><i /><i /><i /></div>
          <div className={s.emptyBody}>
            <h2 id="empty-h">Your profile is built from a resume</h2>
            <p>Upload one first. Synapse reads it, lays out your experience, projects and skills here, and you correct anything it got wrong. The desktop app answers from what you review.</p>
            <Link className="btn btn-primary" href="/resumes"><Icon name="upload" size={16} />Upload a resume</Link>
          </div>
        </section>
      </div>
    );
  }
  const prof = await getProfile(user.id, resume.id);

  return (
    <div className={s.page}>
      <header className={s.head}>
        <div className={s.headCopy}>
          <h1 className={s.h1}>Candidate profile</h1>
          <p>Fields are extracted from your resume text without guessing. Anything the resume did not contain stays empty until you add it. Each field shows where it came from.</p>
        </div>
        <div className={s.source}>
          {resumes.length > 1 ? (
            <nav aria-label="Profile for resume" className={s.picker}>
              {resumes.map((r) => (
                <Link key={r.id} className={s.pick} href={`/profile?resume=${r.id}`} aria-current={r.id === resume.id ? 'true' : undefined}>
                  <Icon name="resume" size={15} />{r.name}
                </Link>
              ))}
            </nav>
          ) : (
            <p className={s.single}><Icon name="resume" size={15} />Built from <Link href={`/resumes/${resume.id}`}>{resume.name}</Link></p>
          )}
          <div className={s.tools}>
            {resumes.length > 1 && <Link className="btn btn-sm btn-ghost" href={`/resumes/${resume.id}`}>Open resume</Link>}
            <ConfirmButton small method="POST" label="Re-extract profile" title="Re-extract from resume text?" body="All fields are rebuilt from the resume text. Your edits to this profile will be replaced." url={`/api/resumes/${resume.id}/profile`} payload={{ confirm: true }} />
          </div>
        </div>
      </header>
      {prof ? (
        <ProfileEditor key={`${resume.id}-${prof.updated_at.toISOString()}`} resumeId={resume.id} initial={prof.profile} />
      ) : (
        <p className="notice">No profile has been built for this resume yet. Use Re-extract profile to build one from its text.</p>
      )}
    </div>
  );
}
