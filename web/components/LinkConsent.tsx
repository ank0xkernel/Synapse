'use client';
import { useState } from 'react';
import { call } from '@/lib/client';

export default function LinkConsent({ params }: { params: Record<string, string> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function decide(approve: boolean) {
    setBusy(true);
    setError('');
    const r = await call<{ redirect: string }>('POST', '/api/desktop/v1/link', { approve, ...params });
    if (!r.ok) {
      setBusy(false);
      return setError(r.error);
    }
    setDone(true);
    // Navigates to the desktop app's loopback listener (http://127.0.0.1:<port>/callback).
    window.location.assign(r.redirect);
  }

  return (
    <div className="stack">
      {error && <p className="form-error" role="alert">{error}</p>}
      {done && <p className="muted" role="status">Returning to the desktop app. You can close this tab afterwards.</p>}
      <div className="row">
        <button className="btn btn-primary" disabled={busy} onClick={() => decide(true)}>Approve</button>
        <button className="btn" disabled={busy} onClick={() => decide(false)}>Cancel</button>
      </div>
    </div>
  );
}
