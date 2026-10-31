import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { listJds } from '@/lib/data';
import { fmtDate } from '@/lib/format';
import { RESPONSE_MODES } from '@/lib/constants';

export const metadata: Metadata = { title: 'Job descriptions' };

export default async function Jobs() {
  const user = await requirePageUser();
  const jds = await listJds(user.id);
  return (
    <div className="stack-lg">
      <div className="page-head page-head-row">
        <div>
          <h1>Job descriptions</h1>
          <p>Paste a posting once and reuse it across sessions.</p>
        </div>
        <Link className="btn btn-primary" href="/jobs/new">Add job description</Link>
      </div>
      {jds.length === 0 ? (
        <div className="empty"><p>No job descriptions yet.</p><Link className="btn btn-primary" href="/jobs/new">Paste your first one</Link></div>
      ) : (
        <div className="card">
          <ul className="list">
            {jds.map((j) => (
              <li key={j.id}>
                <div className="grow stack" style={{ gap: 2 }}>
                  <Link className="title" href={`/jobs/${j.id}`}>{j.role || 'Untitled role'}{j.company ? ` at ${j.company}` : ''}</Link>
                  <span className="meta">{j.parsed.technologies.length} technologies detected - {RESPONSE_MODES.find((m) => m.id === j.response_mode)?.label} style - updated {fmtDate(j.updated_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
