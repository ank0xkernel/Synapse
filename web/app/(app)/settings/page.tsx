import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { listDeviceTokens } from '@/lib/data';
import LinkedDesktops from '@/components/LinkedDesktops';
import { NameForm, PasswordForm, DeleteAccount } from '@/components/SettingsForms';
import s from './settings.module.css';

export const metadata: Metadata = { title: 'Settings' };

export default async function Settings() {
  const user = await requirePageUser();
  const tokens = await listDeviceTokens(user.id);
  return (
    <div className={s.page}>
      <header className={s.head}>
        <h1>Account settings</h1>
        <p>Signed in as <span className={s.email}>{user.email}</span>.</p>
      </header>

      <div className={s.groups}>
        <section className={s.group} aria-labelledby="prof">
          <div className={s.about}>
            <h2 id="prof">Profile</h2>
            <p>The name this website uses for you.</p>
          </div>
          <div className={s.panel}><NameForm name={user.name} /></div>
        </section>

        <section className={s.group} aria-labelledby="pw">
          <div className={s.about}>
            <h2 id="pw">Password</h2>
            <p>Changing it signs out every other browser and unlinks every desktop, so each Mac must link again.</p>
          </div>
          <div className={s.panel}><PasswordForm /></div>
        </section>

        <section className={s.group} aria-labelledby="dev">
          <div className={s.about}>
            <h2 id="dev">Linked desktops</h2>
            <p>Every Mac or tool that can read your context. Link a new one, and check whether each has your latest context, on the <Link href="/desktop">Desktop</Link> page.</p>
          </div>
          <div className={s.list}><LinkedDesktops tokens={tokens} /></div>
        </section>
      </div>

      <section className={s.danger} aria-labelledby="del">
        <div className={s.about}>
          <h2 id="del">Delete account</h2>
          <p>Permanently removes your account and every resume, file, profile, job description, session, preparation result and device token. This cannot be undone.</p>
        </div>
        <div className={s.dangerBody}><DeleteAccount /></div>
      </section>
    </div>
  );
}
