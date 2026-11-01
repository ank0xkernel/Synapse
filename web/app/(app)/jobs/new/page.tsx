import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { listResumes } from '@/lib/data';
import JdForm from '@/components/JdForm';
import s from '../jobs.module.css';

export const metadata: Metadata = { title: 'Add job description' };

export default async function NewJd() {
  const user = await requirePageUser();
  const resumes = await listResumes(user.id);
  return (
    <div className="stack-lg">
      <div className="page-head">
        <p className="crumb"><Link href="/jobs">Job descriptions</Link></p>
        <h1>Add job description</h1>
        <p>After you save, the posting opens as a workspace: its requirements line by line, set against the resume you link.</p>
      </div>
      <section className={`card ${s.edit}`} aria-labelledby="new-h">
        <h2 id="new-h" className="sr-only">Job description details</h2>
        <JdForm resumes={resumes.map((r) => ({ id: r.id, name: r.name }))} />
      </section>
    </div>
  );
}
