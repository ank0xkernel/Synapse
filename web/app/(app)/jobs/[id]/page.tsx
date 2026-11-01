import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageUser } from '@/lib/auth';
import { getJd, getProfile, listResumes } from '@/lib/data';
import { uuid } from '@/lib/http';
import { compare } from '@/lib/prep';
import { fmtDate } from '@/lib/format';
import { RESPONSE_MODES } from '@/lib/constants';
import { extractTechnologies } from '@/lib/intelligence/candidate-profile.js';
import JdForm from '@/components/JdForm';
import ConfirmButton from '@/components/ConfirmButton';
import Icon from '@/components/Icon';
import Interchange from '@/components/workflow/Interchange';
import s from '../jobs.module.css';

export const metadata: Metadata = { title: 'Job description' };

export default async function JdPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const [jd, resumes] = await Promise.all([getJd(user.id, id), listResumes(user.id)]);
  if (!jd) notFound();
  const p = jd.parsed;
  const resume = jd.resume_id ? resumes.find((r) => r.id === jd.resume_id) ?? null : null;
  const prof = resume ? await getProfile(user.id, resume.id) : null;
  const cmp = prof ? compare(prof.profile, p) : null;
  const matched = new Set(cmp?.matched ?? []);
  const named = new Set(p.technologies);
  // Technologies in one line, limited to those the whole posting was found to name.
  const techsIn = (line: string) => (extractTechnologies(line) as string[]).filter((t) => named.has(t));

  const groups = [
    { key: 'required', title: 'Requirements', note: 'What the employer says you must have.', lines: p.requiredSkills, none: 'No “Requirements” section found.' },
    { key: 'preferred', title: 'Nice to have', note: 'What they would like but do not require.', lines: p.preferredSkills, none: 'No “Nice to have” or “Preferred” section found.' },
    { key: 'resp', title: 'Responsibilities', note: 'What you would do in the role.', lines: p.responsibilities, none: 'No “Responsibilities” section found.' }
  ];

  return (
    <div className="stack-lg">
      <div className="page-head">
        <p className="crumb"><Link href="/jobs">Job descriptions</Link></p>
        <div className="row-between">
          <h1>{jd.role || 'Untitled role'}{jd.company ? <span className={s.at}> at {jd.company}</span> : null}</h1>
          <div className="row">
            <Link className="btn btn-primary" href={`/sessions/new?jd=${jd.id}`}><Icon name="plus" size={16} />Create session</Link>
            <a className="btn" href="#edit"><Icon name="edit" size={16} />Edit</a>
            <ConfirmButton label="Delete" title="Delete this job description?" body="Sessions that used it stay, but lose the link." url={`/api/jds/${jd.id}`} redirectTo="/jobs" />
          </div>
        </div>
        <ul className={s.metaLine}>
          <li>{RESPONSE_MODES.find((m) => m.id === jd.response_mode)?.label} answers</li>
          <li>{resume ? <>Compared with <Link href={`/resumes/${resume.id}`}>{resume.name}</Link></> : 'No resume linked'}</li>
          <li>Updated {fmtDate(jd.updated_at)}</li>
        </ul>
      </div>

      {cmp && resume ? (
        <Interchange matched={cmp.matched} gaps={cmp.gaps} resumeOnly={cmp.resumeOnly} resumeName={resume.name} headingId="match" />
      ) : (
        <section className={s.unlinked} aria-labelledby="match">
          <h2 id="match">Technologies the posting names</h2>
          {p.technologies.length ? (
            <ul className={s.techList}>{p.technologies.map((t) => <li key={t}>{t}</li>)}</ul>
          ) : (
            <p className="muted">None from the known list.</p>
          )}
          <p className="notice">
            {resume
              ? `${resume.name} has no candidate profile yet, so there is nothing to compare. Open the resume to review it.`
              : 'Link a resume below to see which of these your resume shows and which it does not.'}
          </p>
        </section>
      )}

      <section className={s.asks} aria-labelledby="asks">
        <div className={s.asksHead}>
          <h2 id="asks">What the posting asks, line by line</h2>
          <p className="meta">
            Read from the text you saved with fixed rules. {cmp ? 'Each line shows the technologies it names, marked when your resume has them.' : 'Each line shows the technologies it names.'}
          </p>
        </div>
        {groups.map((g) => (
          <div key={g.key} className={s.group}>
            <div className={s.groupHead}>
              <h3>{g.title}</h3>
              <span className={s.mono}>{g.lines.length}</span>
              <p>{g.note}</p>
            </div>
            {g.lines.length ? (
              <ol className={s.lines}>
                {g.lines.map((line, i) => {
                  const techs = techsIn(line);
                  return (
                    <li key={i} className={s.line}>
                      <span className={s.lineText}>{line}</span>
                      {techs.length > 0 && (
                        <span className={s.marks}>
                          {techs.map((t) => (
                            <span key={t} className={s.mark} data-state={!cmp ? 'plain' : matched.has(t) ? 'match' : 'gap'}>
                              {t}
                              {cmp && <span className="sr-only">{matched.has(t) ? ' (on your resume)' : ' (not on your resume)'}</span>}
                            </span>
                          ))}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className={s.none}>{g.none}</p>
            )}
          </div>
        ))}
      </section>

      <section id="edit" className={`card ${s.edit}`} aria-labelledby="edit-h">
        <h2 id="edit-h">Edit the posting</h2>
        <JdForm initial={jd} resumes={resumes.map((r) => ({ id: r.id, name: r.name }))} />
      </section>
    </div>
  );
}
