import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { safeNext } from '@/lib/pkce';
import AuthForm from '@/components/AuthForm';

export const metadata: Metadata = { title: 'Create account' };

export default async function Signup({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  if (await currentUser()) redirect(next);
  return (
    <main className="auth">
      <div className="card auth-card">
        <h1>Create your account</h1>
        <AuthForm mode="signup" next={next} />
      </div>
    </main>
  );
}
