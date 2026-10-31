'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';

/** Rename and edit the extracted text. Saves only what the server confirms. */
export default function ResumeEditor({ id, name, text }: { id: string; name: string; text: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setMsg(null);
        const r = await call('PATCH', `/api/resumes/${id}`, { name: f.get('name'), extractedText: f.get('text') });
        setBusy(false);
        if (!r.ok) return setMsg({ ok: false, text: r.error });
        setMsg({ ok: true, text: 'Saved.' });
        router.refresh();
      }}
    >
      <div className="field">
        <label htmlFor="r-name">Name</label>
        <input id="r-name" name="name" className="input" defaultValue={name} required maxLength={120} />
      </div>
      <div className="field">
        <label htmlFor="r-text">Extracted text</label>
        <textarea id="r-text" name="text" className="textarea" rows={16} defaultValue={text} required maxLength={200000} aria-describedby="r-text-hint" />
        <span id="r-text-hint" className="hint">Fix extraction mistakes here. Use &ldquo;Re-extract profile&rdquo; on the Profile page to rebuild fields from this text.</span>
      </div>
      <div className="row">
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save changes'}</button>
        {msg && <span className={msg.ok ? 'form-ok' : 'form-error'} role="status">{msg.text}</span>}
      </div>
    </form>
  );
}
