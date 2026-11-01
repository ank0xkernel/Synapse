import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { getResume, listResumes, type ResumeSummary } from '@/lib/data';
import { fmtBytes, fmtDate } from '@/lib/format';
import UploadResume from '@/components/UploadResume';
import PostButton from '@/components/PostButton';
import ConfirmButton from '@/components/ConfirmButton';
import Icon from '@/components/Icon';
import DocSheet from '@/components/resume/DocSheet';
import { ANALYSED_BY, PARSE, READ_SHORT, docKind } from '@/components/resume/labels';
import s from './resumes.module.css';

export const metadata: Metadata = { title: 'Resumes' };

const DELETE_BODY = 'The file, extracted text and profile are permanently removed. Sessions that used it keep their other settings.';

function Facts({ r }: { r: ResumeSummary }) {
  const parse = PARSE[r.parse_status];
  return (
    <dl className={s.facts}>
      <div><dt>Read as</dt><dd>{READ_SHORT[r.extraction_method] ?? 'Text'}</dd></div>
      <div><dt>Profile built by</dt><dd>{ANALYSED_BY[r.analysis_method]}</dd></div>
      <div><dt>Extracted</dt><dd className="num">{r.text_chars.toLocaleString('en-US')} characters</dd></div>
      <div><dt>Status</dt><dd><span className="status" data-tone={parse.tone}>{parse.text}</span></dd></div>
      <div><dt>Size</dt><dd className="num">{fmtBytes(r.size_bytes)}</dd></div>
      <div><dt>Added</dt><dd className="num">{fmtDate(r.created_at)}</dd></div>
      <div><dt>Updated</dt><dd className="num">{fmtDate(r.updated_at)}</dd></div>
    </dl>
  );
}

export default async function Resumes() {
  const user = await requirePageUser();
  const resumes = await listResumes(user.id);
  // ponytail: one query per resume for the paper preview; fine for a personal library, add a preview column to listResumes if libraries grow large.
  const full = await Promise.all(resumes.map((r) => getResume(user.id, r.id)));
  const texts = new Map(full.map((r) => [r?.id ?? '', r?.extracted_text.slice(0, 1600) ?? '']));
  const active = resumes.find((r) => r.is_active);
  const others = resumes.filter((r) => r !== active);

  return (
    <div className={s.page}>
      <header className="page-head">
        <h1 className={s.h1}>Resumes</h1>
        <p>Keep several versions. The active resume is the one the desktop app uses when no session is selected.</p>
      </header>

      <UploadResume first={resumes.length === 0} />

      {resumes.length === 0 ? (
        <section className={s.after} aria-labelledby="after-h">
          <h2 id="after-h">What happens after you upload</h2>
          <ol>
            <li><b>The text is read.</b> From the PDF itself, from a Word file, or from scanned pages when AI is set up.</li>
            <li><b>A candidate profile is built.</b> Experience, projects, skills and education, keeping only what your resume says.</li>
            <li><b>You review it.</b> Correct anything on the Profile page. The desktop app answers from that reviewed profile.</li>
          </ol>
        </section>
      ) : (
        <section className={s.library} aria-labelledby="lib">
          <div className={s.libHead}>
            <h2 id="lib">Library</h2>
            <p className="meta num">{resumes.length} {resumes.length === 1 ? 'resume' : 'resumes'}</p>
          </div>

          {active && (
            <article className={s.featured} aria-labelledby={`r-${active.id}`}>
              <Link href={`/resumes/${active.id}`} className={s.sheetLink} tabIndex={-1} aria-hidden="true">
                <DocSheet large active kind={docKind(active.file_name)} text={texts.get(active.id) ?? ''} failed={active.parse_status === 'failed'} />
              </Link>
              <div className={s.featuredBody}>
                <span className="status" data-tone="accent">Active, used by the desktop app</span>
                <h3 id={`r-${active.id}`} className={s.featuredName}><Link href={`/resumes/${active.id}`}>{active.name}</Link></h3>
                <p className={s.file}>{active.file_name}</p>
                <Facts r={active} />
                <div className={s.actions}>
                  <Link className="btn btn-primary" href={`/resumes/${active.id}`}>Open workspace<Icon name="arrow" size={16} /></Link>
                  <Link className="btn" href={`/profile?resume=${active.id}`}>Review profile</Link>
                  <ConfirmButton label="Delete" title={`Delete "${active.name}"?`} body={DELETE_BODY} url={`/api/resumes/${active.id}`} />
                </div>
              </div>
            </article>
          )}

          {others.length > 0 && (
            <div className={s.shelfWrap}>
              {active && <h3 className={s.shelfHead}>Other versions</h3>}
              <ol className={s.shelf}>
                {others.map((r) => (
                  <li key={r.id} className={s.row}>
                    <Link href={`/resumes/${r.id}`} className={s.sheetLink} tabIndex={-1} aria-hidden="true">
                      <DocSheet kind={docKind(r.file_name)} text={texts.get(r.id) ?? ''} failed={r.parse_status === 'failed'} />
                    </Link>
                    <div className={s.rowBody}>
                      <div className={s.rowTitle}>
                        <Link className={s.name} href={`/resumes/${r.id}`}>{r.name}</Link>
                        <span className={s.file}>{r.file_name}</span>
                      </div>
                      <Facts r={r} />
                    </div>
                    <div className={s.rowActions}>
                      <PostButton small label="Make active" url={`/api/resumes/${r.id}/activate`} />
                      <ConfirmButton small label="Delete" title={`Delete "${r.name}"?`} body={DELETE_BODY} url={`/api/resumes/${r.id}`} />
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
