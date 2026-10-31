'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';

/** One-click POST/DELETE that refreshes server data after the server says ok. */
export default function PostButton(props: { label: string; url: string; method?: string; payload?: unknown; small?: boolean; primary?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <button
        type="button"
        className={`btn${props.small ? ' btn-sm' : ''}${props.primary ? ' btn-primary' : ''}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          const r = await call(props.method ?? 'POST', props.url, props.payload ?? {});
          setBusy(false);
          if (!r.ok) setError(r.error);
          else router.refresh();
        }}
      >
        {busy ? 'Working...' : props.label}
      </button>
      {error && <span className="form-error" role="alert">{error}</span>}
    </>
  );
}
