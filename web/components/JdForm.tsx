'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';
import { RESPONSE_MODES } from '@/lib/constants';

interface Initial { id?: string; company: string; role: string; text: string; resume_id: string | null; response_mode: string }

export default function JdForm({ initial, resumes }: { initial?: Initial; resumes: { id: string; name: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setMsg(null);
        const body = {
          company: f.get('company'),
          role: f.get('role'),
          text: f.get('text'),
          resumeId: f.get('resumeId') || null,
          responseMode: f.get('responseMode')
        };
        const r = initial?.id ? await call('PATCH', `/api/jds/${initial.id}`, body) : await call<{ id: string }>('POST', '/api/jds', body);
        setBusy(false);
        if (!r.ok) return setMsg({ ok: false, text: r.error });
        if (!initial?.id) router.push(`/jobs/${(r as { id: string }).id}`);
        else setMsg({ ok: true, text: 'Saved.' });
        router.refresh();
      }}
    >
      <div className="grid-2">
        <div className="field">
          <label htmlFor="jd-company">Company</label>
          <input id="jd-company" name="company" className="input" defaultValue={initial?.company} maxLength={120} />
        </div>
        <div className="field">
          <label htmlFor="jd-role">Role</label>
          <input id="jd-role" name="role" className="input" defaultValue={initial?.role} maxLength={120} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="jd-text">Job description</label>
        <textarea id="jd-text" name="text" className="textarea" rows={14} defaultValue={initial?.text} required maxLength={40000} />
        <span className="hint">Paste the posting. Headings like Responsibilities and Requirements are detected automatically.</span>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="jd-resume">Resume for this job</label>
          <select id="jd-resume" name="resumeId" className="select" defaultValue={initial?.resume_id ?? ''}>
            <option value="">None</option>
            {resumes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="jd-mode">Preferred answer style</label>
          <select id="jd-mode" name="responseMode" className="select" defaultValue={initial?.response_mode ?? 'professional'}>
            {RESPONSE_MODES.map((m) => <option key={m.id} value={m.id}>{m.label} - {m.description}</option>)}
          </select>
        </div>
      </div>
      <div className="row">
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : initial?.id ? 'Save changes' : 'Save job description'}</button>
        {msg && <span className={msg.ok ? 'form-ok' : 'form-error'} role="status">{msg.text}</span>}
      </div>
    </form>
  );
}
