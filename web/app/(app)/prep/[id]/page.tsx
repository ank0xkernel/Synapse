import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageUser } from '@/lib/auth';
import { getSession, latestPrep } from '@/lib/data';
import { uuid } from '@/lib/http';
import { aiConfigured } from '@/lib/prep';
import { fmtDateTime } from '@/lib/format';
import PrepRunner from '@/components/PrepRunner';

export const metadata: Metadata = { title: 'Preparation' };

const FromResume = () => <span className="tag" data-kind="resume">From your resume</span>;
const AiTag = () => <span className="tag" data-kind="ai">AI suggestion</span>;

export default async function PrepPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const s = await getSession(user.id, id);
  if (!s) notFound();
  const { comparison: cmp, ai } = await latestPrep(user.id, s.id);
  const ready = !!(s.resume_id && s.jd_id);
  const c = cmp?.content;
  const a = ai?.content;

  return (
    <div className="stack-lg">
      <div className="page-head">
        <p className="meta"><Link href="/prep">Preparation</Link></p>
        <h1>{s.title}</h1>
        <p className="meta">{s.resume_name ?? 'No resume'} - {s.jd_label ?? 'No job description'}</p>
      </div>

      {!ready && (
        <div className="notice" data-tone="warning">
          This session needs both a resume and a job description. <Link href={`/sessions/${s.id}`}>Edit the session</Link>.
        </div>
      )}
      <PrepRunner sessionId={s.id} aiConfigured={aiConfigured()} ready={ready} />

      <section className="card stack" aria-labelledby="cmp">
        <div className="row-between"><h2 id="cmp">Resume and job description comparison</h2>{cmp && <span className="meta">Computed {fmtDateTime(cmp.created_at)}</span>}</div>
        {!c ? <p className="muted">Not run yet. This comparison uses fixed rules on the text you saved. It does not use AI.</p> : (
          <>
            <div className="stack" style={{ gap: 8 }}>
              <h3>Matched <FromResume /></h3>
              <p className="meta">Technologies named in both your resume and the job description.</p>
              {c.matched.length ? <div className="chip-list">{c.matched.map((t) => <span className="chip" key={t}>{t}</span>)}</div> : <p className="muted">No overlap found in the known technology list.</p>}
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <h3>Skill gaps</h3>
              <p className="meta">In the job description, not found in your resume. They may still be things you know; add them to your profile if so.</p>
              {c.gaps.length ? <div className="chip-list">{c.gaps.map((t) => <span className="chip" key={t}>{t}</span>)}</div> : <p className="muted">No gaps found in the known technology list.</p>}
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <h3>Role-relevant topics</h3>
              <p className="meta">Technologies the job description mentions.</p>
              {c.topics.length ? <div className="chip-list">{c.topics.map((t) => <span className="chip" key={t}>{t}</span>)}</div> : <p className="muted">None detected.</p>}
            </div>
            {c.jdRequirements.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                <h3>Required skills as written in the job description</h3>
                <ul className="plain">{c.jdRequirements.map((t, i) => <li key={i}>{t}</li>)}</ul>
              </div>
            )}
          </>
        )}
      </section>

      <section className="card stack" aria-labelledby="ai">
        <div className="row-between"><h2 id="ai">AI preparation <AiTag /></h2>{ai && <span className="meta">Generated {fmtDateTime(ai.created_at)} by {ai.model}</span>}</div>
        <p className="meta">Generated from your resume and job description when you click the button. These are suggestions to practise with, not facts about you. Check them against your real experience.</p>
        {!a ? <p className="muted">{aiConfigured() ? 'Not generated yet.' : 'AI preparation needs GEMINI_API_KEY on the server.'}</p> : (
          <>
            <Block title="Practice questions" empty={!a.practiceQuestions.length}>
              <ol className="plain">{a.practiceQuestions.map((q, i) => <li key={i}><strong>{q.question}</strong><br /><span className="meta">{q.topic} - {q.why}</span></li>)}</ol>
            </Block>
            <Block title="Behavioral questions" empty={!a.behavioral.length}>
              <ol className="plain">{a.behavioral.map((q, i) => <li key={i}><strong>{q.question}</strong><br /><span className="meta">{q.why}</span></li>)}</ol>
            </Block>
            <Block title="Project explanation" empty={!a.projectPrep.length} emptyText="No projects on your resume to prepare, so none were generated.">
              <div className="stack">{a.projectPrep.map((p, i) => (
                <div className="card-inset stack" key={i} style={{ gap: 8 }}>
                  <strong>{p.project}</strong> <FromResume />
                  <span className="label">Points to explain</span><ul className="plain">{p.explainPoints.map((x, j) => <li key={j}>{x}</li>)}</ul>
                  <span className="label">Likely follow-ups</span><ul className="plain">{p.likelyFollowUps.map((x, j) => <li key={j}>{x}</li>)}</ul>
                </div>
              ))}</div>
            </Block>
            <Block title="STAR practice" empty={!a.starPractice.length}>
              <div className="stack">{a.starPractice.map((p, i) => (
                <div className="card-inset stack" key={i} style={{ gap: 8 }}>
                  <strong>{p.prompt}</strong>
                  <span className="meta">Based on: {p.basedOn}</span>
                  <dl style={{ margin: 0, display: 'grid', gap: 6 }}>
                    {(['situation', 'task', 'action', 'result'] as const).map((k) => (<div key={k}><dt className="label" style={{ textTransform: 'capitalize' }}>{k}</dt><dd style={{ margin: 0 }}>{p.outline[k]}</dd></div>))}
                  </dl>
                </div>
              ))}</div>
            </Block>
            <Block title="Suggested improvement areas" empty={!a.improvements.length}>
              <ul className="plain">{a.improvements.map((x, i) => <li key={i}><strong>{x.area}</strong>: {x.suggestion}</li>)}</ul>
            </Block>
          </>
        )}
      </section>
    </div>
  );
}

function Block({ title, empty, emptyText, children }: { title: string; empty: boolean; emptyText?: string; children: React.ReactNode }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <h3>{title} <AiTag /></h3>
      {empty ? <p className="muted">{emptyText ?? 'Nothing generated for this section.'}</p> : children}
    </div>
  );
}
