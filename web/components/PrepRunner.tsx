'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';

/** One prep action. `deterministic` re-runs the rule-based comparison; `ai` generates a new set of suggestions. */
export default function PrepRunner(props: { sessionId: string; mode: 'deterministic' | 'ai'; ready: boolean; hasResult: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run() {
    setBusy(true);
    setError('');
    const r = await call('POST', `/api/sessions/${props.sessionId}/prep`, { mode: props.mode });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else router.refresh();
  }

  const label =
    props.mode === 'deterministic'
      ? busy ? 'Comparing...' : props.hasResult ? 'Compare again' : 'Compare resume and job description'
      : busy ? 'Generating (up to a minute)...' : props.hasResult ? 'Generate a new set' : 'Generate AI preparation';

  return (
    <div className="row">
      <button type="button" className={`btn${props.hasResult ? '' : ' btn-primary'}`} disabled={!props.ready || busy} onClick={run}>
        {label}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
