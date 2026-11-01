'use client';
import { useState } from 'react';
import Link from 'next/link';
import { call } from '@/lib/client';
import Icon from '@/components/Icon';

export default function AuthForm({ mode, next = '/dashboard' }: { mode: 'login' | 'signup'; next?: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const signup = mode === 'signup';

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email') || '').trim();
    const password = String(f.get('password') || '');
    const name = String(f.get('name') || '').trim();

    if (!email) {
      setError('Please enter your email address.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid email address.');
      return;
    }
    if (signup && password.length < 10) {
      setError('Password must be at least 10 characters.');
      return;
    }
    if (!password) {
      setError('Please enter your password.');
      return;
    }

    setBusy(true);
    setError('');
    const r = await call('POST', `/api/auth/${mode}`, {
      email,
      password,
      ...(signup ? { name } : {})
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
        <input
          id="email"
          name="email"
          type="email"
          className="input"
          autoComplete="email"
          required
          aria-invalid={!!error && error.toLowerCase().includes('email')}
        />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <div className="input-wrap">
          <input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            className="input"
            required
            minLength={signup ? 10 : 1}
            autoComplete={signup ? 'new-password' : 'current-password'}
            aria-describedby={signup ? 'pw-hint' : undefined}
            aria-invalid={!!error && error.toLowerCase().includes('password')}
          />
          <button
            type="button"
            className="input-eye"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            onClick={() => setShowPassword(!showPassword)}
            tabIndex={-1}
          >
            <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
          </button>
        </div>
        {signup && <span id="pw-hint" className="hint">At least 10 characters.</span>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button
        className="btn btn-primary btn-lg"
        disabled={busy}
        data-busy={busy}
        aria-busy={busy}
      >
        {busy ? 'Please wait...' : signup ? 'Create account' : 'Sign in'}
      </button>
      <p className="meta">
        {signup ? 'Already have an account? ' : 'New here? '}
        <Link href={`${signup ? '/login' : '/signup'}${next === '/dashboard' ? '' : `?next=${encodeURIComponent(next)}`}`}>
          {signup ? 'Sign in' : 'Create an account'}
        </Link>
      </p>
    </form>
  );
}
