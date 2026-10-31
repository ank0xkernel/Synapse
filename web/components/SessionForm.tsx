'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';
import { INTERVIEW_TYPES, RESPONSE_MODES } from '@/lib/constants';

interface Initial {
  id?: string; title: string; company: string; role: string; interview_type: string; response_mode: string;
  notes: string; status: string; scheduled_at: string | null; resume_id: string | null; jd_id: string | null;
}
interface Jd { id: string; label: string; company: string; role: string }

/** datetime-local wants local wall time without a zone. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export default function SessionForm(props: {
  initial?: Initial;
  resumes: { id: string; name: string }[];
  jds: Jd[];
  defaultResumeId: string | null;
}) {
  const { initial } = props;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const when = String(f.get('scheduledAt') || '');
        setBusy(true);
        setMsg(null);
        const body = {
          title: f.get('title'),
          company: f.get('company'),
          role: f.get('role'),
          interviewType: f.get('interviewType'),
          responseMode: f.get('responseMode'),
          notes: f.get('notes'),
          status: f.get('status'),
          scheduledAt: when ? new Date(when).toISOString() : null,
          resumeId: f.get('resumeId') || null,
          jdId: f.get('jdId') || null
        };
        const r = initial?.id ? await call('PATCH', `/api/sessions/${initial.id}`, body) : await call<{ id: string }>('POST', '/api/sessions', body);
        setBusy(false);
        if (!r.ok) return setMsg({ ok: false, text: r.error });
        if (!initial?.id) router.push(`/sessions/${(r as { id: string }).id}`);
        else setMsg({ ok: true, text: 'Saved.' });
        router.refresh();
      }}
    >
      <div className="field">
        <label htmlFor="s-title">Title</label>
        <input id="s-title" name="title" className="input" defaultValue={initial?.title} required maxLength={160} placeholder="Backend interview, round 2" />
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="s-company">Company</label>
          <input id="s-company" name="company" className="input" defaultValue={initial?.company} maxLength={120} />
        </div>
        <div className="field">
          <label htmlFor="s-role">Role</label>
          <input id="s-role" name="role" className="input" defaultValue={initial?.role} maxLength={120} />
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="s-resume">Resume</label>
          <select id="s-resume" name="resumeId" className="select" defaultValue={initial ? initial.resume_id ?? '' : props.defaultResumeId ?? ''}>
            <option value="">None</option>
            {props.resumes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="s-jd">Job description</label>
          <select id="s-jd" name="jdId" className="select" defaultValue={initial?.jd_id ?? ''}>
            <option value="">None</option>
            {props.jds.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
          </select>
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="s-type">Interview type</label>
          <select id="s-type" name="interviewType" className="select" defaultValue={initial?.interview_type ?? 'general'}>
            {INTERVIEW_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="s-mode">Answer style</label>
          <select id="s-mode" name="responseMode" className="select" defaultValue={initial?.response_mode ?? 'professional'}>
            {RESPONSE_MODES.map((m) => <option key={m.id} value={m.id}>{m.label} - {m.description}</option>)}
          </select>
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="s-when">Scheduled for</label>
          <input id="s-when" name="scheduledAt" type="datetime-local" className="input" defaultValue={toLocalInput(initial?.scheduled_at ?? null)} />
        </div>
        <div className="field">
          <label htmlFor="s-status">Status</label>
          <select id="s-status" name="status" className="select" defaultValue={initial?.status ?? 'draft'}>
            <option value="draft">Draft</option>
            <option value="ready">Ready</option>
            <option value="completed">Completed</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="s-notes">Interview context</label>
        <textarea id="s-notes" name="notes" className="textarea" rows={8} defaultValue={initial?.notes} maxLength={8000} />
        <span className="hint">Your own notes: interviewer names, team, topics to stress, things to avoid. Sent to the desktop app as written.</span>
      </div>
      <div className="row">
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : initial?.id ? 'Save session' : 'Create session'}</button>
        {msg && <span className={msg.ok ? 'form-ok' : 'form-error'} role="status">{msg.text}</span>}
      </div>
    </form>
  );
}
