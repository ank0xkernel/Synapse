import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import BrandMark from '@/components/BrandMark';
import Icon from '@/components/Icon';
import ThemeSwitch from '@/components/ThemeSwitch';
import { currentUser } from '@/lib/auth';
import { parseLinkRequest } from '@/lib/pkce';
import LinkConsent from '@/components/LinkConsent';
import s from './link.module.css';

export const metadata: Metadata = { title: 'Link Synapse Desktop' };
export const dynamic = 'force-dynamic';

const READS = ['Your active resume', 'Your candidate profile', 'Your job description', 'Your session notes'];

function Top() {
  return (
    <div className={s.top}>
      <Link href="/" className="brand"><BrandMark />Synapse</Link>
      <ThemeSwitch />
    </div>
  );
}

export default async function LinkDesktop({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const parsed = parseLinkRequest(flat);
  if (!parsed.ok) {
    return (
      <div className={s.page}>
        <Top />
        <main className={s.sheet} id="main">
          <h1 className={s.title}>Cannot link this app</h1>
          <p className="notice" data-tone="danger" role="alert">{parsed.error}</p>
          <p className={s.lede}>Open the link again from the Synapse desktop app.</p>
          <div className={s.actions}><Link className="btn btn-lg" href="/dashboard">Go to dashboard</Link></div>
        </main>
      </div>
    );
  }
  const user = await currentUser();
  if (!user) {
    const qs = new URLSearchParams(flat as Record<string, string>).toString();
    redirect(`/login?next=${encodeURIComponent(`/desktop/link?${qs}`)}`);
  }
  return (
    <div className={s.page}>
      <Top />
      <main className={s.sheet} id="main">
        <div className={s.pair} aria-hidden="true">
          <span className={s.end}><Icon name="desktop" size={20} />Synapse Desktop</span>
          <span className={s.wire}><span className={s.wireLine} /><Icon name="link" size={16} /></span>
          <span className={s.end}><Icon name="profile" size={20} /><span className={s.email}>{user.email}</span></span>
        </div>

        <h1 className={s.title}>Link Synapse Desktop to {user.email}?</h1>
        <p className={s.lede}>The desktop app on this computer will be able to read your active resume, profile, job description and session notes. You can unlink it any time from Settings.</p>

        <div className={s.facts}>
          <section aria-labelledby="reads-h">
            <h2 id="reads-h" className={s.factH}>It will read</h2>
            <ul className={s.reads}>
              {READS.map((r) => <li key={r}><Icon name="check" size={16} />{r}</li>)}
            </ul>
          </section>
          <section aria-labelledby="req-h">
            <h2 id="req-h" className={s.factH}>This request</h2>
            <dl className={s.req}>
              <div><dt>Account</dt><dd>{user.email}</dd></div>
              <div><dt>Returns to</dt><dd><code className={s.code}>{parsed.req.redirect_uri}</code><span className={s.sub}>An address on this computer only</span></dd></div>
              <div><dt>Unlink</dt><dd>Any time, from Settings</dd></div>
            </dl>
          </section>
        </div>

        <div className={s.decide}>
          <p className={s.warn}><Icon name="lock" size={16} />Approve only if you just started linking from the Synapse desktop app on this computer.</p>
          <LinkConsent params={{ client: flat.client!, redirect_uri: parsed.req.redirect_uri, code_challenge: parsed.req.code_challenge, code_challenge_method: 'S256', state: parsed.req.state }} />
        </div>
      </main>
    </div>
  );
}
