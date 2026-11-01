import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { safeNext } from '@/lib/pkce';
import AuthForm from '@/components/AuthForm';
import AuthFrame from '@/components/landing/AuthFrame';

export const metadata: Metadata = { title: 'Create account' };

export default async function Signup({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  if (await currentUser()) redirect(next);
  return (
    <AuthFrame mode="signup" title="Create your account" intro="Keep your resume, job descriptions and interview sessions in one place for the desktop app." linking={next.startsWith('/desktop/link')}>
      <AuthForm mode="signup" next={next} />
    </AuthFrame>
  );
}
