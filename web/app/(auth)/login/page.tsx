import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { safeNext } from '@/lib/pkce';
import AuthForm from '@/components/AuthForm';

export const metadata: Metadata = { title: 'Sign in' };

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  if (await currentUser()) redirect(next);
  return (
    <main className="auth">
      <div className="card auth-card">
        <h1>Sign in</h1>
        <AuthForm mode="login" next={next} />
      </div>
    </main>
  );
}
