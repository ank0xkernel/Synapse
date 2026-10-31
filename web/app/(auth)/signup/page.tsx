import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { safeNext } from '@/lib/pkce';
import AuthForm from '@/components/AuthForm';

export const metadata: Metadata = { title: 'Create account' };

export default async function Signup({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  if (await currentUser()) redirect(next);
  return (
    <main className="auth" id="main">
      <Link href="/" className="brand"><span className="brand-mark" aria-hidden="true" />Synapse</Link>
      <div className="card auth-card">
        <div className="stack" style={{ gap: 6 }}>
          <h1>Create your account</h1>
          <p className="muted">Keep your resume, job descriptions and interview sessions in one place for the desktop app.</p>
        </div>
        <AuthForm mode="signup" next={next} />
      </div>
    </main>
  );
}
