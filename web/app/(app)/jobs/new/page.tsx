import type { Metadata } from 'next';
import { requirePageUser } from '@/lib/auth';
import { listResumes } from '@/lib/data';
import JdForm from '@/components/JdForm';

export const metadata: Metadata = { title: 'Add job description' };

export default async function NewJd() {
  const user = await requirePageUser();
  const resumes = await listResumes(user.id);
  return (
    <div className="stack-lg">
      <div className="page-head"><h1>Add job description</h1></div>
      <div className="card"><JdForm resumes={resumes.map((r) => ({ id: r.id, name: r.name }))} /></div>
    </div>
  );
}
