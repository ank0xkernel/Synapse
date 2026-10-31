import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { getActiveResume, getSession, listDeviceTokens } from '@/lib/data';
import DeviceTokenCreate from '@/components/DeviceTokens';
import LinkedDesktops from '@/components/LinkedDesktops';

export const metadata: Metadata = { title: 'Desktop' };

export default async function Desktop() {
  const user = await requirePageUser();
  const [tokens, active, session] = await Promise.all([
    listDeviceTokens(user.id),
    getActiveResume(user.id),
    user.activeSessionId ? getSession(user.id, user.activeSessionId) : null
  ]);
  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>Desktop connection</h1>
        <p>The desktop app fetches your context once, just before a session starts, and caches it. Live answers never wait on this website.</p>
      </div>

      <section className="card stack" aria-labelledby="what">
        <h2 id="what">What the desktop app will receive</h2>
        {session ? (
          <p>Session <Link href={`/sessions/${session.id}`}>{session.title}</Link> with its resume ({session.resume_name ?? 'none'}), job description ({session.jd_label ?? 'none'}), answer style and notes.</p>
        ) : active ? (
          <p>No session is loaded, so the desktop app gets your active resume <Link href={`/resumes/${active.id}`}>{active.name}</Link> and its profile. Load a session from the <Link href="/sessions">Sessions</Link> page to include a job description.</p>
        ) : (
          <p className="notice" data-tone="warning">Nothing to send yet. <Link href="/resumes">Upload a resume</Link> or <Link href="/sessions/new">create a session</Link>.</p>
        )}
      </section>

      <section className="card stack" aria-labelledby="steps">
        <h2 id="steps">Connect the desktop app</h2>
        <ol className="plain">
          <li>In the desktop app, choose &ldquo;Sign in to Synapse web&rdquo;. Your browser opens this site.</li>
          <li>Check the account shown and select Approve. The browser hands a one-time code back to the app on your own computer.</li>
          <li>Before an interview the app fetches your context once and works from its cached copy. Live answers never wait on this site.</li>
        </ol>
        <p className="meta">The sign-in uses a one-time code with PKCE and a loopback address, so the app never sees your password. Tokens last 90 days from last use. Contract: docs/desktop-web-contract.md.</p>
      </section>

      <section className="card stack" aria-labelledby="tok">
        <h2 id="tok">Linked desktops</h2>
        <LinkedDesktops tokens={tokens} />
      </section>

      <section className="card stack" aria-labelledby="manual">
        <h2 id="manual">Manual token</h2>
        <p className="muted">For scripts or tools that cannot use browser sign-in. Treat it like a password.</p>
        <DeviceTokenCreate />
      </section>
    </div>
  );
}
