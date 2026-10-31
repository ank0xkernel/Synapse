'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';
import ConfirmButton from './ConfirmButton';

type Msg = { ok: boolean; text: string } | null;
const Status = ({ m }: { m: Msg }) => (m ? <span className={m.ok ? 'form-ok' : 'form-error'} role="status">{m.text}</span> : null);

export function NameForm({ name }: { name: string }) {
  const router = useRouter();
  const [m, setM] = useState<Msg>(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await call('PATCH', '/api/account', { name: new FormData(e.currentTarget).get('name') });
        setM(r.ok ? { ok: true, text: 'Saved.' } : { ok: false, text: r.error });
        if (r.ok) router.refresh();
      }}
    >
      <div className="field">
        <label htmlFor="acct-name">Name</label>
        <input id="acct-name" name="name" className="input" defaultValue={name} maxLength={100} autoComplete="name" />
      </div>
      <div className="row"><button className="btn btn-primary">Save name</button><Status m={m} /></div>
    </form>
  );
}

export function PasswordForm() {
  const [m, setM] = useState<Msg>(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        const r = await call('POST', '/api/account/password', { current: f.get('current'), next: f.get('next') });
        setM(r.ok ? { ok: true, text: 'Password changed. Other devices were signed out.' } : { ok: false, text: r.error });
        if (r.ok) form.reset();
      }}
    >
      <div className="field">
        <label htmlFor="pw-cur">Current password</label>
        <input id="pw-cur" name="current" type="password" className="input" required autoComplete="current-password" />
      </div>
      <div className="field">
        <label htmlFor="pw-new">New password</label>
        <input id="pw-new" name="next" type="password" className="input" required minLength={10} autoComplete="new-password" />
        <span className="hint">At least 10 characters.</span>
      </div>
      <div className="row"><button className="btn btn-primary">Change password</button><Status m={m} /></div>
    </form>
  );
}

export function DeleteAccount() {
  const [pw, setPw] = useState('');
  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="del-pw">Password</label>
        <input id="del-pw" type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
      </div>
      <div>
        <ConfirmButton
          label="Delete account"
          title="Delete your account?"
          body="This permanently deletes your resumes, uploaded files, profiles, job descriptions, sessions and device tokens."
          url="/api/account"
          payload={{ password: pw }}
          redirectTo="/"
        />
      </div>
    </div>
  );
}
