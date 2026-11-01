import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { getProfile, listJds, listResumes } from '@/lib/data';
import { compare } from '@/lib/prep';
import { fmtDate } from '@/lib/format';
import { RESPONSE_MODES } from '@/lib/constants';
import Icon from '@/components/Icon';
import { MatchTicks } from '@/components/workflow/Interchange';
import s from './jobs.module.css';

export const metadata: Metadata = { title: 'Job descriptions' };

export default async function Jobs() {
  const user = await requirePageUser();
  const [jds, resumes] = await Promise.all([listJds(user.id), listResumes(user.id)]);
  const linked = [...new Set(jds.map((j) => j.resume_id).filter((id): id is string => !!id))];
  const profiles = new Map(await Promise.all(linked.map(async (id) => [id, (await getProfile(user.id, id))?.profile ?? null] as const)));
  const resumeName = new Map(resumes.map((r) => [r.id, r.name]));

  return (
    <div className="stack-lg">
      <div className="page-head page-head-row">
        <div>
          <h1>Job descriptions</h1>
          <p>Paste a posting once. Synapse reads its requirements and sets them against the resume you link to it.</p>
        </div>
        {jds.length > 0 && <Link className="btn btn-primary" href="/jobs/new"><Icon name="plus" size={16} />Add job description</Link>}
      </div>

      {jds.length === 0 ? (
        <section className={s.empty} aria-labelledby="jobs-empty">
          <h2 id="jobs-empty">No postings yet</h2>
          <p>Paste a job description and Synapse reads it with fixed rules, no AI. It sorts the lines under these headings and picks out the technologies the posting names:</p>
          <dl className={s.emptyList}>
            <div><dt>Responsibilities</dt><dd>What you would do in the role.</dd></div>
            <div><dt>Requirements</dt><dd>What the employer says you must have.</dd></div>
            <div><dt>Nice to have</dt><dd>What they would like but do not require.</dd></div>
          </dl>
          <Link className="btn btn-primary" href="/jobs/new"><Icon name="plus" size={16} />Paste your first posting</Link>
        </section>
      ) : (
        <ol className={s.rows}>
          {jds.map((j) => {
            const prof = j.resume_id ? profiles.get(j.resume_id) : null;
            const cmp = prof ? compare(prof, j.parsed) : null;
            const p = j.parsed;
            const total = p.technologies.length;
            return (
              <li key={j.id} className={s.row}>
                <div className={s.ident}>
                  <Link className={s.title} href={`/jobs/${j.id}`}>{j.role || 'Untitled role'}</Link>
                  <span className={s.company}>{j.company || 'No company set'}</span>
                </div>
                <div className={s.match}>
                  {cmp && total > 0 ? (
                    <>
                      <MatchTicks matched={cmp.matched.length} total={total} />
                      <span className={s.matchText}>
                        <span className={s.mono}>{cmp.matched.length}/{total}</span> named technologies are in {resumeName.get(j.resume_id ?? '') ?? 'the linked resume'}
                      </span>
                    </>
                  ) : (
                    <span className={s.matchText}>
                      {total === 0
                        ? 'Names no technologies from the known list'
                        : j.resume_id
                          ? `${total} technologies named; the linked resume has no profile yet`
                          : `${total} technologies named; link a resume to compare`}
                    </span>
                  )}
                </div>
                <ul className={s.facts} aria-label="Detected lines">
                  <li><span className={s.mono}>{p.requiredSkills.length}</span> required</li>
                  <li><span className={s.mono}>{p.preferredSkills.length}</span> preferred</li>
                  <li><span className={s.mono}>{p.responsibilities.length}</span> responsibilities</li>
                </ul>
                <div className={s.side}>
                  <span>{RESPONSE_MODES.find((m) => m.id === j.response_mode)?.label} answers</span>
                  <span>Updated {fmtDate(j.updated_at)}</span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
