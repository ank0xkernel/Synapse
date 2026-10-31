'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';

export default function DeviceTokenCreate() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div className="stack">
      <form
        className="row"
        style={{ alignItems: 'flex-end' }}
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          setBusy(true);
          setError('');
          const r = await call<{ token: string }>('POST', '/api/device-tokens', { name: new FormData(form).get('name') });
          setBusy(false);
          if (!r.ok) return setError(r.error);
          form.reset();
          setToken(r.token);
          setCopied(false);
          router.refresh();
        }}
      >
        <div className="field grow" style={{ minWidth: 200 }}>
          <label htmlFor="tok-name">Token name</label>
          <input id="tok-name" name="name" className="input" required maxLength={60} placeholder="MacBook Pro" />
        </div>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating...' : 'Create token'}</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
      {token && (
        <div className="notice stack" data-tone="warning" role="status">
          <strong>Copy this token now. It is shown once and cannot be recovered.</strong>
          <div className="token-box" data-testid="new-token">{token}</div>
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={async () => { await navigator.clipboard.writeText(token).catch(() => {}); setCopied(true); }}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setToken('')}>I saved it</button>
          </div>
        </div>
      )}
    </div>
  );
}
