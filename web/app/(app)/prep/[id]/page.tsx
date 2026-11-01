import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageUser } from '@/lib/auth';
import { getSession, latestPrep } from '@/lib/data';
import { uuid } from '@/lib/http';
import { aiConfigured } from '@/lib/prep';
import { fmtDateTime } from '@/lib/format';
import PrepRunner from '@/components/PrepRunner';
import Interchange from '@/components/workflow/Interchange';
import PracticeDeck from '@/components/workflow/PracticeDeck';
import s from '../prep.module.css';

export const metadata: Metadata = { title: 'Preparation' };

export default async function PrepPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const sess = await getSession(user.id, id);
  if (!sess) notFound();
  const { comparison: cmp, ai } = await latestPrep(user.id, sess.id);
  const ready = !!(sess.resume_id && sess.jd_id);
  const c = cmp?.content;
  const a = ai?.content;
  const hasAi = aiConfigured();

  return (
    <div className="stack-lg">
      <div className="page-head">
        <p className="crumb"><Link href="/prep">Preparation</Link></p>
        <div className="row-between">
          <h1>{sess.title}</h1>
          <Link className="btn" href={`/sessions/${sess.id}`}>Session settings</Link>
        </div>
        <ul className={s.metaLine}>
          <li>{sess.resume_name ?? 'No resume'}</li>
          <li>{sess.jd_label ?? 'No job description'}</li>
        </ul>
      </div>

      {!ready && (
        <div className="notice" data-tone="warning">
          This session needs both a resume and a job description. <Link href={`/sessions/${sess.id}`}>Edit the session</Link>.
        </div>
      )}

      <section className={s.step} aria-labelledby="cmp">
        <div className={s.stepHead}>
          <span className={s.stepN} aria-hidden="true">1</span>
          <div className={s.stepTitle}>
            <h2 id="cmp">Skill overview</h2>
            <p className="meta">
              Rule-based comparison of your resume and the job description. No AI.
              {cmp && <> Computed {fmtDateTime(cmp.created_at)}.</>}
            </p>
          </div>
          <PrepRunner sessionId={sess.id} mode="deterministic" ready={ready} hasResult={!!c} />
        </div>
        {!c ? (
          <p className={s.waiting}>Not run yet. The comparison uses fixed rules on the text you saved and lists which technologies the job names that your resume shows, and which it does not.</p>
        ) : (
          <div className={s.stepBody}>
            <Interchange
              matched={c.matched} gaps={c.gaps} resumeOnly={c.resumeOnly}
              resumeName={sess.resume_name ?? "your resume"} headingId="cmp-detail" heading="Where your resume meets the job" level={3}
            />
            {c.jdRequirements.length > 0 && (
              <div className={s.reqs}>
                <h3>Required skills as written in the job description</h3>
                <ol>{c.jdRequirements.map((t, i) => <li key={`${i}:${t}`}>{t}</li>)}</ol>
              </div>
            )}
          </div>
        )}
      </section>

      <section className={s.step} aria-labelledby="ai">
        <div className={s.stepHead}>
          <span className={s.stepN} aria-hidden="true">2</span>
          <div className={s.stepTitle}>
            <h2 id="ai">Practise <span className="tag" data-kind="ai">AI suggestions</span></h2>
            <p className="meta">
              Generated from your resume and job description when you ask. These are suggestions to practise with, not facts about you. Check them against your real experience.
              {ai && <> Generated {fmtDateTime(ai.created_at)} by {ai.model}.</>}
            </p>
          </div>
          {hasAi && <PrepRunner sessionId={sess.id} mode="ai" ready={ready} hasResult={!!a} />}
        </div>
        <div className={s.stepBody}>
          {!hasAi && (
            <div className={s.keyNotice} role="note">
              <p className={s.keyHead}>AI preparation needs GEMINI_API_KEY on the server.</p>
              <p>The skill overview above works without it.</p>
            </div>
          )}
          {a ? <PracticeDeck content={a} /> : hasAi && <p className={s.waiting}>Not generated yet. You get practice questions, behavioral prompts, STAR outlines to reveal step by step, and points for each project on your resume.</p>}
        </div>
      </section>
    </div>
  );
}
