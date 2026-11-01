'use client';
import { useState } from 'react';
import Link from 'next/link';
import { call } from '@/lib/client';

export default function AuthForm({ mode, next = '/dashboard' }: { mode: 'login' | 'signup'; next?: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    const r = await call('POST', `/api/auth/${mode}`, {
      email: f.get('email'),
      password: f.get('password'),
      ...(signup ? { name: f.get('name') } : {})
    });
    if (!r.ok) {
      setBusy(false);
      return setError(r.error);
    }
    window.location.assign(next);
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {signup && (
        <div className="field">
          <label htmlFor="name">Name</label>
          <input id="name" name="name" className="input" autoComplete="name" maxLength={100} />
        </div>
      )}
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" className="input" autoComplete="email" required />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" className="input" required minLength={signup ? 10 : 1} autoComplete={signup ? 'new-password' : 'current-password'} aria-describedby={signup ? 'pw-hint' : undefined} />
        {signup && <span id="pw-hint" className="hint">At least 10 characters.</span>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Please wait...' : signup ? 'Create account' : 'Sign in'}</button>
      <p className="meta">
        {signup ? 'Already have an account? ' : 'New here? '}
        <Link href={`${signup ? '/login' : '/signup'}${next === '/dashboard' ? '' : `?next=${encodeURIComponent(next)}`}`}>{signup ? 'Sign in' : 'Create an account'}</Link>
      </p>
    </form>
  );
}
