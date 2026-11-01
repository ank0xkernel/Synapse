import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { safeNext } from '@/lib/pkce';
import AuthForm from '@/components/AuthForm';
import AuthFrame from '@/components/landing/AuthFrame';

export const metadata: Metadata = { title: 'Sign in' };

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  if (await currentUser()) redirect(next);
  return (
    <AuthFrame mode="login" title="Sign in" intro="Welcome back. Your resumes and sessions are where you left them." linking={next.startsWith('/desktop/link')}>
      <AuthForm mode="login" next={next} />
    </AuthFrame>
  );
}
