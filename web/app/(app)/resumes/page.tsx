import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { listResumes } from '@/lib/data';
import { fmtBytes, fmtDate } from '@/lib/format';
import UploadResume from '@/components/UploadResume';
import PostButton from '@/components/PostButton';
import ConfirmButton from '@/components/ConfirmButton';

export const metadata: Metadata = { title: 'Resumes' };

export default async function Resumes() {
  const user = await requirePageUser();
  const resumes = await listResumes(user.id);
  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>Resumes</h1>
        <p>Keep several versions. The active resume is the one the desktop app uses when no session is selected.</p>
      </div>
      <UploadResume />
      <section className="card" aria-labelledby="lib">
        <h2 id="lib">Your resumes</h2>
        {resumes.length === 0 ? (
          <p className="muted">No resumes yet. Upload a PDF above to get started.</p>
        ) : (
          <ul className="list">
            {resumes.map((r) => (
              <li key={r.id}>
                <div className="grow stack" style={{ gap: 2 }}>
                  <Link className="title" href={`/resumes/${r.id}`}>{r.name}</Link>
                  <span className="meta">{r.file_name} - {fmtBytes(r.size_bytes)} - added {fmtDate(r.created_at)}</span>
                </div>
                {r.is_active ? <span className="status" data-tone="accent">Active</span> : <PostButton small label="Make active" url={`/api/resumes/${r.id}/activate`} />}
                <ConfirmButton small label="Delete" title={`Delete "${r.name}"?`} body="The file, extracted text and profile are permanently removed. Sessions that used it keep their other settings." url={`/api/resumes/${r.id}`} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
