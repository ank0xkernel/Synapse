import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { buildContextBundle, getActiveResume, getSession, listDeviceTokens } from '@/lib/data';
import { RESPONSE_MODES } from '@/lib/constants';
import DeviceTokenCreate from '@/components/DeviceTokens';
import LinkedDesktops from '@/components/LinkedDesktops';
import Icon from '@/components/Icon';
import { accessOf, bestSync } from '@/components/dashboard/sync';
import s from './desktop.module.css';

export const metadata: Metadata = { title: 'Desktop' };

const HEAD = {
  none: ['Link the desktop app', 'The desktop app fetches your context once, just before a session starts, and caches it. Live answers never wait on this website.'],
  latest: ['Your Mac has your latest context', 'Nothing has changed since it last fetched. Live answers come from that cached copy and never wait on this website.'],
  older: ['Your Mac has an older copy of your context', 'Something changed since it last fetched. It updates when the app next checks: select Refresh, or start listening.'],
  never: ['Your Mac is linked but has not fetched your context', 'The app fetches it when you select Refresh or start listening, then works from its cached copy.'],
  unknown: ['Nothing to send to your Mac yet', 'Upload a resume or create a session. The desktop app fetches that context before each interview.']
} as const;

export default async function Desktop() {
  const user = await requirePageUser();
  const [tokens, active, session, bundle] = await Promise.all([
    listDeviceTokens(user.id),
    getActiveResume(user.id),
    user.activeSessionId ? getSession(user.id, user.activeSessionId) : null,
    buildContextBundle(user.id, null)
  ]);
  const now = Date.now();
  const currentVersion = typeof bundle === 'string' ? null : bundle.body.version;
  const sync = bestSync(tokens, currentVersion, now);
  const [title, lead] = HEAD[sync];
  const activeCount = tokens.filter((t) => accessOf(t, now) === 'active').length;
  const settings = typeof bundle === 'string' ? null : bundle.body.settings;
  const mode = RESPONSE_MODES.find((m) => m.id === settings?.response_mode)?.label ?? settings?.response_mode;

  return (
    <div className={s.page}>
      <header className={s.head}>
        <h1>{title}</h1>
        <p>{lead}</p>
      </header>

      <div className={s.top}>
        <section className={`${s.manifest}${sync === 'latest' ? ' fringe' : ''}`} aria-labelledby="what">
          <h2 id="what">What your Mac receives</h2>
          {session || active ? (
            <>
              <dl className={s.fields}>
                <div>
                  <dt>Session</dt>
                  <dd>{session ? <Link href={`/sessions/${session.id}`}>{session.title}</Link> : <span className={s.none}>None loaded. <Link href="/sessions">Load one</Link> to include a job description.</span>}</dd>
                </div>
                <div>
                  <dt>Resume and profile</dt>
                  <dd>
                    {session
                      ? session.resume_id ? <Link href={`/resumes/${session.resume_id}`}>{session.resume_name}</Link> : <span className={s.none}>None chosen for this session</span>
                      : <Link href={`/resumes/${active!.id}`}>{active!.name}</Link>}
                  </dd>
                </div>
                <div>
                  <dt>Job description</dt>
                  <dd>{session?.jd_id ? <Link href={`/jobs/${session.jd_id}`}>{session.jd_label || 'Untitled'}</Link> : <span className={s.none}>None</span>}</dd>
                </div>
                <div>
                  <dt>Answer style</dt>
                  <dd>{mode}</dd>
                </div>
              </dl>
              {currentVersion && <p className={s.version}>Context version <span className="mono">{currentVersion.slice(0, 12)}</span></p>}
            </>
          ) : (
            <p className="notice" data-tone="warning">Nothing to send yet. <Link href="/resumes">Upload a resume</Link> or <Link href="/sessions/new">create a session</Link>.</p>
          )}
        </section>

        <section className={s.howto} aria-labelledby="steps">
          <h2 id="steps">Link a Mac</h2>
          <ol className={s.steps}>
            <li><span className={s.num} aria-hidden="true">1</span><p>In the desktop app, open Resume &amp; context and choose <b>Link with browser</b>. Your browser opens this site.</p></li>
            <li><span className={s.num} aria-hidden="true">2</span><p>Check the account shown and select <b>Approve</b>. The browser hands a one-time code back to the app on your own computer.</p></li>
            <li><span className={s.num} aria-hidden="true">3</span><p>Before an interview the app fetches your context once and works from its cached copy.</p></li>
          </ol>
          <p className={s.fine}><Icon name="lock" size={16} />The sign-in uses a one-time code with PKCE and a loopback address, so the app never sees your password. Tokens last 90 days from last use.</p>
        </section>
      </div>

      <section className={s.section} aria-labelledby="tok">
        <div className={s.sectionHead}>
          <h2 id="tok">Linked desktops</h2>
          {tokens.length > 0 && <span className="meta num">{activeCount} active of {tokens.length}</span>}
        </div>
        <LinkedDesktops tokens={tokens} currentVersion={currentVersion} />
      </section>

      <details className={s.manual}>
        <summary>Use a manual token instead</summary>
        <div className={s.manualBody}>
          <p className="muted">For scripts or tools that cannot use browser sign-in. Treat it like a password.</p>
          <DeviceTokenCreate />
        </div>
      </details>
    </div>
  );
}
