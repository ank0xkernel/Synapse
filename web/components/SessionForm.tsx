'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';
import { INTERVIEW_TYPES, RESPONSE_MODES } from '@/lib/constants';
import f from './workflow/forms.module.css';

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

const STATUSES = [
  { id: 'draft', label: 'Draft' },
  { id: 'ready', label: 'Ready' },
  { id: 'completed', label: 'Completed' }
];

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
  const type = initial?.interview_type ?? 'general';
  const mode = initial?.response_mode ?? 'professional';
  const status = initial?.status ?? 'draft';

  return (
    <form
      className={f.form}
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const when = String(fd.get('scheduledAt') || '');
        setBusy(true);
        setMsg(null);
        const body = {
          title: fd.get('title'),
          company: fd.get('company'),
          role: fd.get('role'),
          interviewType: fd.get('interviewType'),
          responseMode: fd.get('responseMode'),
          notes: fd.get('notes'),
          status: fd.get('status'),
          scheduledAt: when ? new Date(when).toISOString() : null,
          resumeId: fd.get('resumeId') || null,
          jdId: fd.get('jdId') || null
        };
        const r = initial?.id ? await call('PATCH', `/api/sessions/${initial.id}`, body) : await call<{ id: string }>('POST', '/api/sessions', body);
        setBusy(false);
        if (!r.ok) return setMsg({ ok: false, text: r.error });
        if (!initial?.id) router.push(`/sessions/${(r as { id: string }).id}`);
        else setMsg({ ok: true, text: 'Saved.' });
        router.refresh();
      }}
    >
      <div className={f.group} role="group" aria-labelledby="s-g-interview">
        <div className={f.groupHead}>
          <h3 id="s-g-interview">The interview</h3>
          <p>What it is, who it is with, and when.</p>
        </div>
        <div className={f.fields}>
          <div className="field">
            <label htmlFor="s-title">Title</label>
            <input id="s-title" name="title" className="input" defaultValue={initial?.title} required maxLength={160} placeholder="Backend interview, round 2" />
          </div>
          <div className={f.pair}>
            <div className="field">
              <label htmlFor="s-role">Role</label>
              <input id="s-role" name="role" className="input" defaultValue={initial?.role} maxLength={120} />
            </div>
            <div className="field">
              <label htmlFor="s-company">Company</label>
              <input id="s-company" name="company" className="input" defaultValue={initial?.company} maxLength={120} />
            </div>
          </div>
          <fieldset className={f.options}>
            <legend>Interview type</legend>
            <div className={f.optionList}>
              {INTERVIEW_TYPES.map((t) => (
                <label className={f.option} key={t.id}>
                  <input type="radio" name="interviewType" value={t.id} defaultChecked={t.id === type} />
                  <span className={f.optionName}>{t.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className={f.wrapRow}>
            <div className="field">
              <label htmlFor="s-when">Scheduled for</label>
              <input id="s-when" name="scheduledAt" type="datetime-local" className="input" defaultValue={toLocalInput(initial?.scheduled_at ?? null)} />
            </div>
            <fieldset className={f.options}>
              <legend>Status</legend>
              <div className={f.segmented}>
                {STATUSES.map((x) => (
                  <label className={f.segment} key={x.id}>
                    <input type="radio" name="status" value={x.id} defaultChecked={x.id === status} />
                    {x.label}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </div>
      </div>

      <div className={f.group} role="group" aria-labelledby="s-g-material">
        <div className={f.groupHead}>
          <h3 id="s-g-material">Material</h3>
          <p>The resume answers are grounded in, and the job they are aimed at.</p>
        </div>
        <div className={f.pair}>
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
      </div>

      <div className={f.group} role="group" aria-labelledby="s-g-answers">
        <div className={f.groupHead}>
          <h3 id="s-g-answers">Answers</h3>
          <p>How the desktop app shapes answers during the call, and what it should know.</p>
        </div>
        <div className={f.fields}>
          <fieldset className={f.options}>
            <legend>Answer style</legend>
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
          <div className="field">
            <label htmlFor="s-notes">Interview context</label>
            <textarea id="s-notes" name="notes" className="textarea" rows={8} defaultValue={initial?.notes} maxLength={8000} />
            <span className="hint">Your own notes: interviewer names, team, topics to stress, things to avoid. Sent to the desktop app as written.</span>
          </div>
        </div>
      </div>

      <div className={f.actions}>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : initial?.id ? 'Save session' : 'Create session'}</button>
        {msg && <span className={msg.ok ? 'form-ok' : 'form-error'} role="status">{msg.text}</span>}
      </div>
    </form>
  );
}
