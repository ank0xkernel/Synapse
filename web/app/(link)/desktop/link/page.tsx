import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { parseLinkRequest } from '@/lib/pkce';
import LinkConsent from '@/components/LinkConsent';

export const metadata: Metadata = { title: 'Link Synapse Desktop' };
export const dynamic = 'force-dynamic';

export default async function LinkDesktop({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const parsed = parseLinkRequest(flat);
  if (!parsed.ok) {
    return (
      <main className="auth" id="main">
        <div className="card auth-card">
          <h1>Cannot link this app</h1>
          <p className="notice" data-tone="danger" role="alert">{parsed.error}</p>
          <p className="muted">Open the link again from the Synapse desktop app.</p>
          <Link className="btn" href="/dashboard">Go to dashboard</Link>
        </div>
      </main>
    );
  }
  const user = await currentUser();
  if (!user) {
    const qs = new URLSearchParams(flat as Record<string, string>).toString();
    redirect(`/login?next=${encodeURIComponent(`/desktop/link?${qs}`)}`);
  }
  return (
    <main className="auth" id="main">
      <div className="card auth-card">
        <h1>Link Synapse Desktop to {user.email}?</h1>
        <p className="muted">The desktop app on this computer will be able to read your active resume, profile, job description and session notes. You can unlink it any time from Settings.</p>
        <LinkConsent params={{ client: flat.client!, redirect_uri: parsed.req.redirect_uri, code_challenge: parsed.req.code_challenge, code_challenge_method: 'S256', state: parsed.req.state }} />
      </div>
    </main>
  );
}
