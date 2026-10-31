import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageUser } from '@/lib/auth';
import { getResume } from '@/lib/data';
import { fmtBytes, fmtDate } from '@/lib/format';
import { uuid } from '@/lib/http';
import ResumeEditor from '@/components/ResumeEditor';
import ResumeFileActions from '@/components/ResumeFileActions';
import PostButton from '@/components/PostButton';
import ConfirmButton from '@/components/ConfirmButton';

export const metadata: Metadata = { title: 'Resume' };

export default async function ResumePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const r = await getResume(user.id, id);
  if (!r) notFound();
  return (
    <div className="stack-lg">
      <div className="page-head">
        <p className="meta"><Link href="/resumes">Resumes</Link></p>
        <div className="row-between">
          <h1>{r.name}</h1>
          <div className="row">
            {r.is_active ? <span className="status" data-tone="accent">Active</span> : <PostButton label="Make active" url={`/api/resumes/${r.id}/activate`} />}
            <Link className="btn" href={`/profile?resume=${r.id}`}>Edit profile</Link>
            <ConfirmButton label="Delete" title={`Delete "${r.name}"?`} body="The file, extracted text and profile are permanently removed." url={`/api/resumes/${r.id}`} redirectTo="/resumes" />
          </div>
        </div>
        <p className="meta">{r.file_name} - {fmtBytes(r.size_bytes)} - {r.text_chars.toLocaleString('en-US')} characters extracted - updated {fmtDate(r.updated_at)}</p>
      </div>
      <ResumeFileActions id={r.id} status={r.parse_status} error={r.parse_error} />
      <div className="grid-2">
        <section className="card" aria-labelledby="prev">
          <h2 id="prev">Preview</h2>
          {r.has_file ? (
            <iframe className="pdf-frame" src={`/api/resumes/${r.id}/file`} title={`PDF preview of ${r.name}`} />
          ) : (
            <div className="card-inset text-view" tabIndex={0} aria-label="Resume text preview">{r.extracted_text}</div>
          )}
        </section>
        <section className="card" aria-labelledby="ext">
          <h2 id="ext">Details</h2>
          <ResumeEditor id={r.id} name={r.name} text={r.extracted_text} />
        </section>
      </div>
    </div>
  );
}
