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
import Icon from '@/components/Icon';
import s from './resume.module.css';

export const metadata: Metadata = { title: 'Resume' };

export default async function ResumePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const r = await getResume(user.id, id);
  if (!r) notFound();
  return (
    <div className={s.page}>
      <header className={s.head}>
        <p className="crumb"><Link href="/resumes">Resumes</Link></p>
        <div className={s.titleRow}>
          <div className={s.titleBlock}>
            <h1 className={s.h1}>{r.name}</h1>
            {r.is_active && <span className="status" data-tone="accent">Active, used by the desktop app</span>}
          </div>
          <div className={s.actions}>
            {!r.is_active && <PostButton label="Make active" url={`/api/resumes/${r.id}/activate`} />}
            <Link className="btn btn-primary" href={`/profile?resume=${r.id}`}>Edit profile<Icon name="arrow" size={16} /></Link>
            <ConfirmButton label="Delete" title={`Delete "${r.name}"?`} body="The file, extracted text and profile are permanently removed." url={`/api/resumes/${r.id}`} redirectTo="/resumes" />
          </div>
        </div>
        <dl className={s.facts}>
          <div><dt>File</dt><dd className="mono">{r.file_name}</dd></div>
          <div><dt>Size</dt><dd className="num">{fmtBytes(r.size_bytes)}</dd></div>
          <div><dt>Extracted</dt><dd className="num">{r.text_chars.toLocaleString('en-US')} characters</dd></div>
          <div><dt>Added</dt><dd className="num">{fmtDate(r.created_at)}</dd></div>
          <div><dt>Updated</dt><dd className="num">{fmtDate(r.updated_at)}</dd></div>
        </dl>
      </header>

      <div className={s.workspace}>
        <section className={s.doc} aria-labelledby="doc-h">
          <div className={s.docBar}>
            <h2 id="doc-h">{r.has_file ? 'Original PDF' : 'Resume text'}</h2>
            {r.has_file && (
              <a className={s.open} href={`/api/resumes/${r.id}/file`} target="_blank" rel="noopener">
                Open in a new tab<Icon name="external" size={15} />
              </a>
            )}
          </div>
          {r.has_file ? (
            <div className={s.frameWrap}>
              <iframe className={s.frame} src={`/api/resumes/${r.id}/file`} title={`PDF preview of ${r.name}`} />
            </div>
          ) : (
            <div className={`text-view ${s.paper}`} tabIndex={0} aria-label="Resume text preview">{r.extracted_text}</div>
          )}
        </section>

        <div className={s.side}>
          <ResumeFileActions id={r.id} status={r.parse_status} error={r.parse_error} extraction={r.extraction_method} analysis={r.analysis_method} note={r.analysis_note} />
          <ResumeEditor id={r.id} name={r.name} text={r.extracted_text} />
        </div>
      </div>
    </div>
  );
}
