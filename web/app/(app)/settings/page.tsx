import type { Metadata } from 'next';
import { requirePageUser } from '@/lib/auth';
import { listDeviceTokens } from '@/lib/data';
import LinkedDesktops from '@/components/LinkedDesktops';
import { NameForm, PasswordForm, DeleteAccount } from '@/components/SettingsForms';

export const metadata: Metadata = { title: 'Settings' };

export default async function Settings() {
  const user = await requirePageUser();
  const tokens = await listDeviceTokens(user.id);
  return (
    <div className="stack-lg">
      <div className="page-head"><h1>Account settings</h1><p>Signed in as {user.email}.</p></div>
      <div className="grid-2">
        <section className="card stack" aria-labelledby="prof"><h2 id="prof">Profile</h2><NameForm name={user.name} /></section>
        <section className="card stack" aria-labelledby="pw"><h2 id="pw">Password</h2><PasswordForm /></section>
      </div>
      <section className="card stack" aria-labelledby="dev"><h2 id="dev">Linked desktops</h2><LinkedDesktops tokens={tokens} /></section>
      <section className="card stack" aria-labelledby="del">
        <h2 id="del">Delete account</h2>
        <p className="muted">Permanently removes your account and every resume, file, profile, job description, session, preparation result and device token.</p>
        <DeleteAccount />
      </section>
    </div>
  );
}
