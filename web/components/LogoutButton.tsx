'use client';
import { useState } from 'react';
import { call } from '@/lib/client';

export default function LogoutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await call('POST', '/api/auth/logout', {});
        window.location.assign('/');
      }}
    >
      {busy ? 'Signing out...' : 'Sign out'}
    </button>
  );
}
