import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { latestPrep, listSessions } from '@/lib/data';
import { fmtDate } from '@/lib/format';
import Icon from '@/components/Icon';
import { MatchTicks } from '@/components/workflow/Interchange';
import s from './prep.module.css';

export const metadata: Metadata = { title: 'Prep' };

export default async function PrepIndex() {
  const user = await requirePageUser();
  const sessions = (await listSessions(user.id)).filter((x) => x.status !== 'completed');
  const preps = await Promise.all(sessions.map((x) => latestPrep(user.id, x.id)));

  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>Interview preparation</h1>
        <p>Preparation runs per session, using the resume and job description attached to it: first a rule-based skill overview, then AI practice if you want it.</p>
      </div>
      {sessions.length === 0 ? (
        <section className={s.empty} aria-labelledby="prep-empty">
          <h2 id="prep-empty">Nothing to prepare for yet</h2>
          <p>Preparation needs a session with a resume and a job description attached. Completed sessions are not listed here.</p>
          <Link className="btn btn-primary" href="/sessions/new"><Icon name="plus" size={16} />New session</Link>
        </section>
      ) : (
        <ol className={s.rows}>
          {sessions.map((x, i) => {
            const c = preps[i].comparison;
            const a = preps[i].ai;
            const ready = !!(x.resume_id && x.jd_id);
            const total = c ? c.content.matched.length + c.content.gaps.length : 0;
            return (
              <li key={x.id} className={s.row}>
                <div className={s.ident}>
                  <Link className={s.title} href={`/prep/${x.id}`}>{x.title}</Link>
                  <span className={s.sub}>{x.resume_name ?? 'No resume'} · {x.jd_label ?? 'No job description'}</span>
                </div>
                <div className={s.state}>
                  {!ready ? (
                    <span className="status" data-tone="warning">Needs resume and job description</span>
                  ) : c ? (
                    <>
                      <MatchTicks matched={c.content.matched.length} total={total} />
                      <span className={s.sub}>
                        {total ? <><span className={s.mono}>{c.content.matched.length}/{total}</span> matched, {c.content.gaps.length} not on the resume · </> : null}
                        compared {fmtDate(c.created_at)}
                      </span>
                    </>
                  ) : (
                    <span className="status">Not compared yet</span>
                  )}
                </div>
                <div className={s.ai}>
                  {a ? <span className="status" data-tone="accent">AI practice set from {fmtDate(a.created_at)}</span> : <span className={s.sub}>No AI practice set</span>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
