'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { call, uploadDriver, uploadPdfDirect } from '@/lib/client';

type Status = 'ok' | 'failed' | 'needs_reprocess';

const LABEL: Record<Status, { text: string; tone: 'positive' | 'danger' | 'warning' }> = {
  ok: { text: 'Parsed', tone: 'positive' },
  failed: { text: 'Parsing failed', tone: 'danger' },
  needs_reprocess: { text: 'Parsed with an older parser', tone: 'warning' }
};

/** Parse status plus Replace file and Reprocess. Profile items you edited are kept by both. */
export default function ResumeFileActions({ id, status, error }: { id: string; status: Status; error: string | null }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const label = LABEL[status];

  async function finish(r: { ok: true } | { ok: false; error: string }, done: string) {
    setBusy('');
    setMsg(r.ok ? { ok: true, text: done } : { ok: false, text: r.error });
    if (r.ok) router.refresh();
  }

  async function reprocess() {
    setBusy('Reprocessing...');
    setMsg(null);
    await finish(await call('POST', `/api/resumes/${id}/reprocess`), 'Reprocessed. Your profile edits were kept.');
  }

  async function replace(file: File | undefined) {
    if (!file) return;
    setMsg(null);
    if (!/\.pdf$/i.test(file.name)) return setMsg({ ok: false, text: 'Choose a PDF file.' });
    if (file.size > 8 * 1024 * 1024) return setMsg({ ok: false, text: 'That file is larger than 8 MB.' });
    setBusy('Uploading...');
    if ((await uploadDriver()) === 'blob') return finish(await uploadPdfDirect(file, { replaceId: id, onStage: (s) => setBusy(`${s}...`) }), 'File replaced.');
    const f = new FormData();
    f.set('file', file);
    try {
      const res = await fetch(`/api/resumes/${id}/file`, { method: 'PUT', body: f });
      const data = await res.json().catch(() => null);
      await finish(res.ok && data?.ok ? { ok: true } : { ok: false, error: data?.error || `Upload failed (${res.status})` }, 'File replaced.');
    } catch {
      await finish({ ok: false, error: 'Network error. Check your connection and try again.' }, '');
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <span className="status" data-tone={label.tone}>{label.text}</span>
        <button type="button" className="btn btn-sm" disabled={!!busy} onClick={reprocess}>Reprocess</button>
        <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => input.current?.click()}>Replace file</button>
        <input ref={input} type="file" accept=".pdf,application/pdf" className="sr-only" aria-label="Replacement PDF" onChange={(e) => { replace(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {status === 'failed' && error && <p className="form-error" role="alert">{error}</p>}
      {status === 'needs_reprocess' && <p className="meta">Reprocess to re-read the original with the current parser. Items you edited stay as they are.</p>}
      {busy && <p className="meta" role="status">{busy}</p>}
      {msg && <p className={msg.ok ? 'form-ok' : 'form-error'} role="status">{msg.text}</p>}
    </div>
  );
}
