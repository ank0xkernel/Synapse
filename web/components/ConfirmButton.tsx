'use client';
import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';

/** Destructive action behind a native <dialog> (focus trap + Escape for free). Navigates or refreshes only after the server confirms. */
export default function ConfirmButton(props: {
  label: string;
  title: string;
  body: string;
  url: string;
  method?: string;
  payload?: unknown;
  redirectTo?: string;
  small?: boolean;
}) {
  const tid = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run() {
    setBusy(true);
    setError('');
    const r = await call(props.method ?? 'DELETE', props.url, props.payload);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    ref.current?.close();
    if (props.redirectTo) router.push(props.redirectTo);
    router.refresh();
  }

  return (
    <>
      <button type="button" className={`btn btn-danger${props.small ? ' btn-sm' : ''}`} onClick={() => ref.current?.showModal()}>
        {props.label}
      </button>
      <dialog ref={ref} aria-labelledby={tid} onClose={() => setError('')}>
        <h2 id={tid}>{props.title}</h2>
        <p className="muted">{props.body}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="row">
          <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={run} disabled={busy}>{busy ? 'Working...' : props.label}</button>
        </div>
      </dialog>
    </>
  );
}
