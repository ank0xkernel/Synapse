'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { call, uploadDriver, uploadPdfDirect } from '@/lib/client';
import Icon from '@/components/Icon';
import { PARSE, READ_BY, type ParseStatus } from '@/components/resume/labels';
import s from '@/components/resume/workspace.module.css';

/** How the resume was read and analysed, plus Replace file and Reprocess. Profile items you edited are kept by both. */
export default function ResumeFileActions({ id, status, error, extraction, analysis, note }: {
  id: string;
  status: ParseStatus;
  error: string | null;
  extraction: string;
  analysis: 'rules' | 'ai';
  note: string | null;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const label = PARSE[status];

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

  const state = busy ? 'forming' : status === 'failed' ? 'dispersed' : status === 'ok' && !note ? 'vivid' : 'partial';

  return (
    <section className={s.reading} data-state={state} aria-labelledby="reading-h">
      <span className={s.edge} aria-hidden="true" />
      <div className={s.readingHead}>
        <h2 id="reading-h">How it was read</h2>
        {busy ? <span className="status" data-tone="busy" role="status">{busy}</span> : <span className="status" data-tone={label.tone}>{label.text}</span>}
      </div>

      <ol className={s.pipeline}>
        <li data-ok={status !== 'failed'}>
          <span className={s.node} aria-hidden="true" />
          <div>
            <h3>Text</h3>
            <p>{READ_BY[extraction] ?? 'Text extracted'}.</p>
          </div>
        </li>
        <li data-ok={status !== 'failed' && !note}>
          <span className={s.node} aria-hidden="true" />
          <div>
            <h3>Profile</h3>
            <p>Profile built {analysis === 'ai' ? 'by AI, keeping only what your resume says' : 'by section rules'}.</p>
            {note && <p className={s.note} role="status">{note} Reprocess to try again.</p>}
          </div>
        </li>
      </ol>

      {status === 'failed' && error && <p className="form-error" role="alert">{error}</p>}
      {status === 'needs_reprocess' && <p className="meta">Reprocess to re-read the original with the current parser. Items you edited stay as they are.</p>}
      {msg && <p className={msg.ok ? 'form-ok' : 'form-error'} role="status">{msg.text}</p>}

      <div className={s.readingActions}>
        <button type="button" className="btn btn-sm" disabled={!!busy} onClick={reprocess}><Icon name="refresh" size={15} />Reprocess</button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => input.current?.click()}><Icon name="upload" size={15} />Replace file</button>
        <input ref={input} type="file" accept=".pdf,application/pdf" className="sr-only" aria-label="Replacement PDF" onChange={(e) => { replace(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
    </section>
  );
}
