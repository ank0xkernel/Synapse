'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';
import { RESPONSE_MODES } from '@/lib/constants';
import f from './workflow/forms.module.css';

interface Initial { id?: string; company: string; role: string; text: string; resume_id: string | null; response_mode: string }

export default function JdForm({ initial, resumes }: { initial?: Initial; resumes: { id: string; name: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const mode = initial?.response_mode ?? 'professional';

  return (
    <form
      className={f.form}
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setBusy(true);
        setMsg(null);
        const body = {
          company: fd.get('company'),
          role: fd.get('role'),
          text: fd.get('text'),
          resumeId: fd.get('resumeId') || null,
          responseMode: fd.get('responseMode')
        };
        const r = initial?.id ? await call('PATCH', `/api/jds/${initial.id}`, body) : await call<{ id: string }>('POST', '/api/jds', body);
        setBusy(false);
        if (!r.ok) return setMsg({ ok: false, text: r.error });
        if (!initial?.id) router.push(`/jobs/${(r as { id: string }).id}`);
        else setMsg({ ok: true, text: 'Saved.' });
        router.refresh();
      }}
    >
      <div className={f.group} role="group" aria-labelledby="jd-g-posting">
        <div className={f.groupHead}>
          <h3 id="jd-g-posting">The posting</h3>
          <p>Paste it as written. Headings like Responsibilities, Requirements and Nice to have are detected automatically.</p>
        </div>
        <div className={f.fields}>
          <div className={f.pair}>
            <div className="field">
              <label htmlFor="jd-role">Role</label>
              <input id="jd-role" name="role" className="input" defaultValue={initial?.role} maxLength={120} />
            </div>
            <div className="field">
              <label htmlFor="jd-company">Company</label>
              <input id="jd-company" name="company" className="input" defaultValue={initial?.company} maxLength={120} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="jd-text">Job description</label>
            <textarea id="jd-text" name="text" className={`textarea ${f.paper}`} rows={14} defaultValue={initial?.text} required maxLength={40000} />
          </div>
        </div>
      </div>

      <div className={f.group} role="group" aria-labelledby="jd-g-use">
        <div className={f.groupHead}>
          <h3 id="jd-g-use">Use it with</h3>
          <p>The resume to compare against, and the answer style new sessions for this job start with.</p>
        </div>
        <div className={f.fields}>
          <div className="field">
            <label htmlFor="jd-resume">Resume for this job</label>
            <select id="jd-resume" name="resumeId" className="select" defaultValue={initial?.resume_id ?? ''}>
              <option value="">None</option>
              {resumes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <fieldset className={f.options}>
            <legend>Preferred answer style</legend>
            <div className={f.optionList}>
              {RESPONSE_MODES.map((m) => (
                <label className={f.option} key={m.id}>
                  <input type="radio" name="responseMode" value={m.id} defaultChecked={m.id === mode} />
                  <span className={f.optionName}>{m.label}</span>
                  <span className={f.optionDesc}>{m.description}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </div>

      <div className={f.actions}>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : initial?.id ? 'Save changes' : 'Save job description'}</button>
        {msg && <span className={msg.ok ? 'form-ok' : 'form-error'} role="status">{msg.text}</span>}
      </div>
    </form>
  );
}
