'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';
import ConfirmButton from './ConfirmButton';
import Icon from './Icon';

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
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);

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
        <div className="input-wrap">
          <input
            id="pw-cur"
            name="current"
            type={showCurrent ? 'text' : 'password'}
            className="input"
            required
            autoComplete="current-password"
          />
          <button
            type="button"
            className="input-eye"
            aria-label={showCurrent ? 'Hide current password' : 'Show current password'}
            onClick={() => setShowCurrent(!showCurrent)}
            tabIndex={-1}
          >
            <Icon name={showCurrent ? 'eyeOff' : 'eye'} size={18} />
          </button>
        </div>
      </div>
      <div className="field">
        <label htmlFor="pw-new">New password</label>
        <div className="input-wrap">
          <input
            id="pw-new"
            name="next"
            type={showNext ? 'text' : 'password'}
            className="input"
            required
            minLength={10}
            autoComplete="new-password"
            aria-describedby="pw-new-hint"
          />
          <button
            type="button"
            className="input-eye"
            aria-label={showNext ? 'Hide new password' : 'Show new password'}
            onClick={() => setShowNext(!showNext)}
            tabIndex={-1}
          >
            <Icon name={showNext ? 'eyeOff' : 'eye'} size={18} />
          </button>
        </div>
        <span id="pw-new-hint" className="hint">At least 10 characters.</span>
      </div>
      <div className="row"><button className="btn btn-primary">Change password</button><Status m={m} /></div>
    </form>
  );
}

export function DeleteAccount() {
  const [pw, setPw] = useState('');
  const [showPw, setShowPw] = useState(false);

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="del-pw">Password</label>
        <div className="input-wrap">
          <input
            id="del-pw"
            type={showPw ? 'text' : 'password'}
            className="input"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoComplete="current-password"
          />
          <button
            type="button"
            className="input-eye"
            aria-label={showPw ? 'Hide password' : 'Show password'}
            onClick={() => setShowPw(!showPw)}
            tabIndex={-1}
          >
            <Icon name={showPw ? 'eyeOff' : 'eye'} size={18} />
          </button>
        </div>
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
