'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';

export default function PrepRunner(props: { sessionId: string; aiConfigured: boolean; ready: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<'deterministic' | 'ai' | null>(null);
  const [error, setError] = useState('');

  async function run(mode: 'deterministic' | 'ai') {
    setBusy(mode);
    setError('');
    const r = await call('POST', `/api/sessions/${props.sessionId}/prep`, { mode });
    setBusy(null);
    if (!r.ok) setError(r.error);
    else router.refresh();
  }

  return (
    <div className="stack">
      <div className="row">
        <button className="btn btn-primary" disabled={!props.ready || !!busy} onClick={() => run('deterministic')}>
          {busy === 'deterministic' ? 'Comparing...' : 'Compare resume and job description'}
        </button>
        <button className="btn" disabled={!props.ready || !props.aiConfigured || !!busy} onClick={() => run('ai')}>
          {busy === 'ai' ? 'Generating (up to a minute)...' : 'Generate AI preparation'}
        </button>
      </div>
      {!props.aiConfigured && <p className="notice" data-tone="warning">AI preparation needs GEMINI_API_KEY on the server. The comparison above works without it.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
