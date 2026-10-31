import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageUser } from '@/lib/auth';
import { getJd, listResumes } from '@/lib/data';
import { uuid } from '@/lib/http';
import JdForm from '@/components/JdForm';
import ConfirmButton from '@/components/ConfirmButton';

export const metadata: Metadata = { title: 'Job description' };

export default async function JdPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const [jd, resumes] = await Promise.all([getJd(user.id, id), listResumes(user.id)]);
  if (!jd) notFound();
  const p = jd.parsed;
  return (
    <div className="stack-lg">
      <div className="page-head">
        <p className="meta"><Link href="/jobs">Job descriptions</Link></p>
        <div className="row-between">
          <h1>{jd.role || 'Untitled role'}{jd.company ? ` at ${jd.company}` : ''}</h1>
          <div className="row">
            <Link className="btn" href={`/sessions/new?jd=${jd.id}`}>Create session</Link>
            <ConfirmButton label="Delete" title="Delete this job description?" body="Sessions that used it stay, but lose the link." url={`/api/jds/${jd.id}`} redirectTo="/jobs" />
          </div>
        </div>
      </div>
      <div className="grid-2">
        <section className="card" aria-labelledby="edit"><h2 id="edit">Edit</h2><JdForm initial={jd} resumes={resumes.map((r) => ({ id: r.id, name: r.name }))} /></section>
        <section className="card stack" aria-labelledby="det">
          <h2 id="det">What was detected</h2>
          <p className="meta">Read from the text you saved, using fixed rules. Nothing is inferred.</p>
          <div><h3>Technologies</h3>{p.technologies.length ? <div className="chip-list" style={{ marginTop: 8 }}>{p.technologies.map((t) => <span className="chip" key={t}>{t}</span>)}</div> : <p className="muted">None from the known list.</p>}</div>
          <div><h3>Required skills</h3>{p.requiredSkills.length ? <ul className="plain" style={{ marginTop: 8 }}>{p.requiredSkills.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p className="muted">No &ldquo;Requirements&rdquo; section found.</p>}</div>
          <div><h3>Responsibilities</h3>{p.responsibilities.length ? <ul className="plain" style={{ marginTop: 8 }}>{p.responsibilities.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p className="muted">No &ldquo;Responsibilities&rdquo; section found.</p>}</div>
        </section>
      </div>
    </div>
  );
}
