'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';
import type { Profile, Source } from '@/lib/profile-types';

type Entry = Profile['experience'][number];
type TextItem = Profile['skills'][number];
type ListKey = 'skills' | 'achievements' | 'certifications';
type EntryKey = 'experience' | 'projects';

const Prov = ({ source }: { source: Source }) =>
  source === 'extracted' ? <span className="tag" data-kind="resume">From your resume</span> : <span className="tag" data-kind="user">Edited by you</span>;

export default function ProfileEditor({ resumeId, initial }: { resumeId: string; initial: Profile }) {
  const router = useRouter();
  const [p, setP] = useState<Profile>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const edit = (fn: (d: Profile) => void) => {
    const d = structuredClone(p);
    fn(d);
    setP(d);
    setDirty(true);
    setMsg(null);
  };

  async function save() {
    setBusy(true);
    const r = await call<{ profile: Profile }>('PUT', `/api/resumes/${resumeId}/profile`, p);
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setP(r.profile);
    setDirty(false);
    setMsg({ ok: true, text: 'Saved.' });
    router.refresh();
  }

  const list = (key: ListKey, label: string, hint: string) => (
    <section className="card stack" aria-labelledby={`h-${key}`}>
      <div className="section-head">
        <h2 id={`h-${key}`}>{label}</h2>
        <button type="button" className="btn btn-sm" onClick={() => edit((d) => d[key].push({ text: '', source: 'user' }))}>Add</button>
      </div>
      {p[key].length === 0 && <p className="muted">Nothing found in your resume. {hint}</p>}
      {p[key].map((it: TextItem, i: number) => (
        <div className="row" key={i} style={{ alignItems: 'flex-start' }}>
          <div className="field grow">
            <label htmlFor={`${key}-${i}`} className="sr-only">{label} item {i + 1}</label>
            <textarea id={`${key}-${i}`} className="textarea" style={{ minHeight: 44 }} rows={2} value={it.text} maxLength={2000} onChange={(e) => edit((d) => { d[key][i].text = e.target.value; })} />
            <Prov source={it.source} />
          </div>
          <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove ${label} item ${i + 1}`} onClick={() => edit((d) => { d[key].splice(i, 1); })}>Remove</button>
        </div>
      ))}
    </section>
  );

  const entries = (key: EntryKey, label: string, nameLabel: string) => (
    <section className="card stack" aria-labelledby={`h-${key}`}>
      <div className="section-head">
        <h2 id={`h-${key}`}>{label}</h2>
        <button type="button" className="btn btn-sm" onClick={() => edit((d) => d[key].push({ name: '', dates: '', bullets: [], technologies: [], source: 'user' }))}>Add</button>
      </div>
      {p[key].length === 0 && <p className="muted">Nothing found in your resume. Add entries yourself if you want them in your context.</p>}
      {p[key].map((en: Entry, i: number) => (
        <div className="entry" key={i}>
          <div className="grid-2">
            <div className="field">
              <label htmlFor={`${key}-n-${i}`}>{nameLabel}</label>
              <input id={`${key}-n-${i}`} className="input" value={en.name} maxLength={300} onChange={(e) => edit((d) => { d[key][i].name = e.target.value; })} />
            </div>
            <div className="field">
              <label htmlFor={`${key}-d-${i}`}>Dates</label>
              <input id={`${key}-d-${i}`} className="input" value={en.dates} maxLength={100} onChange={(e) => edit((d) => { d[key][i].dates = e.target.value; })} />
            </div>
          </div>
          <div className="field">
            <label htmlFor={`${key}-b-${i}`}>Details (one per line)</label>
            <textarea id={`${key}-b-${i}`} className="textarea" rows={4} value={en.bullets.join('\n')} onChange={(e) => edit((d) => { d[key][i].bullets = e.target.value.split('\n').filter((l) => l.trim()); })} />
          </div>
          <div className="field">
            <label htmlFor={`${key}-t-${i}`}>Technologies (comma separated)</label>
            <input key={en.technologies.join(",")} id={`${key}-t-${i}`} className="input" defaultValue={en.technologies.join(', ')} onBlur={(e) => edit((d) => { d[key][i].technologies = e.target.value.split(',').map((t) => t.trim()).filter(Boolean); })} />
          </div>
          <div className="row-between">
            <Prov source={en.source} />
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => edit((d) => { d[key].splice(i, 1); })} aria-label={`Remove ${label} entry ${i + 1}`}>Remove</button>
          </div>
        </div>
      ))}
    </section>
  );

  return (
    <div className="stack-lg">
      <section className="card stack" aria-labelledby="h-edu">
        <div className="section-head">
          <h2 id="h-edu">Education</h2>
          <button type="button" className="btn btn-sm" onClick={() => edit((d) => d.education.push({ text: '', grade: '', source: 'user' }))}>Add</button>
        </div>
        {p.education.length === 0 && <p className="muted">Nothing found in your resume. Add entries yourself if you want them in your context.</p>}
        {p.education.map((it, i) => (
          <div className="entry" key={i}>
            <div className="field">
              <label htmlFor={`edu-${i}`}>Institution, degree and field</label>
              <textarea id={`edu-${i}`} className="textarea" style={{ minHeight: 44 }} rows={2} value={it.text} maxLength={2000} onChange={(e) => edit((d) => { d.education[i].text = e.target.value; })} />
            </div>
            <div className="field">
              <label htmlFor={`edu-g-${i}`}>Grade</label>
              <input id={`edu-g-${i}`} className="input" value={it.grade} maxLength={60} onChange={(e) => edit((d) => { d.education[i].grade = e.target.value; })} />
            </div>
            <div className="row-between">
              <Prov source={it.source} />
              <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove education entry ${i + 1}`} onClick={() => edit((d) => { d.education.splice(i, 1); })}>Remove</button>
            </div>
          </div>
        ))}
      </section>
      {entries('experience', 'Work experience', 'Employer and title')}
      {entries('projects', 'Projects', 'Project name')}
      {list('skills', 'Technical skills', 'Add the skills you want practised.')}
      {list('achievements', 'Achievements', 'Add achievements you can back up.')}
      {list('certifications', 'Certifications', 'Add certifications you hold.')}
      <section className="card stack" aria-labelledby="h-cc">
        <h2 id="h-cc">Custom context</h2>
        <div className="field">
          <label htmlFor="cc">Anything the assistant should know about you</label>
          <textarea id="cc" className="textarea" rows={5} value={p.custom_context.text} maxLength={8000} onChange={(e) => edit((d) => { d.custom_context.text = e.target.value; })} />
          <span className="hint">Written by you. It is sent to the desktop app as your own words.</span>
        </div>
      </section>
      <div className="row" style={{ position: 'sticky', bottom: 0, padding: '12px 0', background: 'var(--surface-0)' }}>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving...' : 'Save profile'}</button>
        {dirty && !msg && <span className="status" data-tone="warning">Unsaved changes</span>}
        {msg && <span className={msg.ok ? 'form-ok' : 'form-error'} role="status">{msg.text}</span>}
      </div>
    </div>
  );
}
