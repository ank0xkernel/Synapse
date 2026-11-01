import type { Metadata } from 'next';
import BrandMark from '@/components/BrandMark';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { safeNext } from '@/lib/pkce';
import AuthForm from '@/components/AuthForm';

export const metadata: Metadata = { title: 'Sign in' };

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  if (await currentUser()) redirect(next);
  return (
    <main className="auth" id="main">
      <Link href="/" className="brand"><BrandMark />Synapse</Link>
      <div className="card auth-card">
        <div className="stack" style={{ gap: 6 }}>
          <h1>Sign in</h1>
          <p className="muted">Welcome back. Your resumes and sessions are where you left them.</p>
        </div>
        <AuthForm mode="login" next={next} />
      </div>
    </main>
  );
}
