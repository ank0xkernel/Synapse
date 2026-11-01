'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call } from '@/lib/client';
import type { Profile, Source } from '@/lib/profile-types';
import Icon from '@/components/Icon';
import s from '@/components/resume/profile.module.css';

type Entry = Profile['experience'][number];
type TextItem = Profile['skills'][number];
type ListKey = 'summary' | 'contact' | 'skills' | 'achievements' | 'certifications';
type EntryKey = 'experience' | 'projects';

const Prov = ({ source }: { source: Source }) =>
  source === 'extracted' ? <span className="tag" data-kind="resume">From your resume</span> : <span className="tag" data-kind="user">Edited by you</span>;

/** "3 from your resume, 1 by you": the provenance of a whole section at a glance. */
function Origin({ items }: { items: { source: Source }[] }) {
  if (items.length === 0) return null;
  const fromResume = items.filter((i) => i.source === 'extracted').length;
  const parts = [fromResume && `${fromResume} from your resume`, items.length - fromResume && `${items.length - fromResume} by you`].filter(Boolean);
  return <span className={s.origin}>{parts.join(', ')}</span>;
}

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

  const head = (id: string, label: string, items: { source: Source }[], onAdd: () => void) => (
    <div className={s.head}>
      <h2 id={id}>{label}</h2>
      <Origin items={items} />
      <button type="button" className={`btn btn-sm btn-ghost ${s.add}`} aria-label={`Add ${label.toLowerCase()} item`} onClick={onAdd}>
        <Icon name="plus" size={15} />Add
      </button>
    </div>
  );

  const empty = (text: string) => <p className={s.empty}>{text}</p>;

  const remove = (label: string, i: number, text: string, onRemove: () => void) => {
    const words = text.trim().split(/\s+/).slice(0, 4).join(' ');
    return (
      <button type="button" className={`btn btn-sm btn-ghost ${s.remove}`} aria-label={`Remove ${label} item ${i + 1}${words ? `: ${words}` : ''}`} onClick={onRemove}>
        <Icon name="close" size={15} />
      </button>
    );
  };

  /** Short text items. `tone` sets how they read: identity lines, a summary paragraph, or compact facts in the margin. */
  const list = (key: ListKey, label: string, hint: string, tone: 'identity' | 'prose' | 'facts') => (
    <section className={s.section} data-tone={tone} aria-labelledby={`h-${key}`}>
      {head(`h-${key}`, label, p[key], () => edit((d) => d[key].push({ text: '', source: 'user' })))}
      {p[key].length === 0 && empty(`Nothing found in your resume. ${hint}`)}
      {p[key].length > 0 && (
        <ul className={s.items}>
          {p[key].map((it: TextItem, i: number) => (
            <li key={i} className={s.item}>
              <label htmlFor={`${key}-${i}`} className="sr-only">{label} item {i + 1}</label>
              <textarea
                id={`${key}-${i}`}
                className={`textarea compact ${s.autosize}`}
                data-lead={tone === 'identity' && i === 0}
                rows={tone === 'prose' ? 3 : 1}
                value={it.text}
                maxLength={2000}
                onChange={(e) => edit((d) => { d[key][i].text = e.target.value; })}
              />
              <div className={s.itemFoot}>
                <Prov source={it.source} />
                {remove(label, i, it.text, () => edit((d) => { d[key].splice(i, 1); }))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  /** Experience and projects: a timeline, newest as the resume lists them, each with its technologies. */
  const entries = (key: EntryKey, label: string, nameLabel: string) => (
    <section className={s.section} aria-labelledby={`h-${key}`}>
      {head(`h-${key}`, label, p[key], () => edit((d) => d[key].push({ name: '', dates: '', bullets: [], technologies: [], source: 'user' })))}
      {p[key].length === 0 && empty('Nothing found in your resume. Add entries yourself if you want them in your context.')}
      {p[key].length > 0 && (
        <ol className={s.timeline}>
          {p[key].map((en: Entry, i: number) => (
            <li key={i} className={s.entry}>
              <span className={s.dot} data-source={en.source} aria-hidden="true" />
              <div className={s.entryHead}>
                <div className="field grow">
                  <label htmlFor={`${key}-n-${i}`}>{nameLabel}</label>
                  <input id={`${key}-n-${i}`} className={`input ${s.title}`} value={en.name} maxLength={300} onChange={(e) => edit((d) => { d[key][i].name = e.target.value; })} />
                </div>
                <div className={`field ${s.dates}`}>
                  <label htmlFor={`${key}-d-${i}`}>Dates</label>
                  <input id={`${key}-d-${i}`} className="input num" value={en.dates} maxLength={100} onChange={(e) => edit((d) => { d[key][i].dates = e.target.value; })} />
                </div>
              </div>
              <div className="field">
                <label htmlFor={`${key}-b-${i}`}>Details (one per line)</label>
                <textarea id={`${key}-b-${i}`} className="textarea" rows={Math.min(8, Math.max(3, en.bullets.length + 1))} value={en.bullets.join('\n')} onChange={(e) => edit((d) => { d[key][i].bullets = e.target.value.split('\n').filter((l) => l.trim()); })} />
              </div>
              <div className="field">
                <label htmlFor={`${key}-t-${i}`}>Technologies (comma separated)</label>
                <input key={en.technologies.join(',')} id={`${key}-t-${i}`} className="input" defaultValue={en.technologies.join(', ')} onBlur={(e) => edit((d) => { d[key][i].technologies = e.target.value.split(',').map((t) => t.trim()).filter(Boolean); })} />
                {en.technologies.length > 0 && (
                  <ul className={s.techs} aria-label={`Technologies in ${en.name || `${label} entry ${i + 1}`}`}>
                    {en.technologies.map((t, j) => <li key={`${t}-${j}`} className="chip">{t}</li>)}
                  </ul>
                )}
              </div>
              <div className={s.itemFoot}>
                <Prov source={en.source} />
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => edit((d) => { d[key].splice(i, 1); })} aria-label={`Remove ${label} entry ${i + 1}`}>Remove</button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );

  return (
    <div className={s.story}>
      <div className={s.identity}>
        {list('contact', 'Name and contact', 'These lines come from the top of your resume.', 'identity')}
        {list('summary', 'Summary', 'Add a short summary of who you are professionally.', 'prose')}
      </div>

      <div className={s.columns}>
        <div className={s.main}>
          {entries('experience', 'Work experience', 'Employer and title')}
          {entries('projects', 'Projects', 'Project name')}

          <section className={s.section} aria-labelledby="h-edu">
            {head('h-edu', 'Education', p.education, () => edit((d) => d.education.push({ text: '', grade: '', source: 'user' })))}
            {p.education.length === 0 && empty('Nothing found in your resume. Add entries yourself if you want them in your context.')}
            {p.education.length > 0 && (
              <ul className={s.items}>
                {p.education.map((it, i) => (
                  <li className={s.edu} key={i}>
                    <div className="field">
                      <label htmlFor={`edu-${i}`}>Institution, degree and field</label>
                      <textarea id={`edu-${i}`} className="textarea compact" rows={2} value={it.text} maxLength={2000} onChange={(e) => edit((d) => { d.education[i].text = e.target.value; })} />
                    </div>
                    <div className={`field ${s.grade}`}>
                      <label htmlFor={`edu-g-${i}`}>Grade</label>
                      <input id={`edu-g-${i}`} className="input" value={it.grade} maxLength={60} onChange={(e) => edit((d) => { d.education[i].grade = e.target.value; })} />
                    </div>
                    <div className={s.itemFoot}>
                      <Prov source={it.source} />
                      <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove education entry ${i + 1}`} onClick={() => edit((d) => { d.education.splice(i, 1); })}>Remove</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className={s.aside}>
          {list('skills', 'Technical skills', 'Add the skills you want practised.', 'facts')}
          {list('certifications', 'Certifications', 'Add certifications you hold.', 'facts')}
          {list('achievements', 'Achievements', 'Add achievements you can back up.', 'facts')}

          <section className={s.section} data-tone="facts" aria-labelledby="h-add">
            {head('h-add', 'Other sections', p.additional, () => edit((d) => d.additional.push({ heading: '', text: '', source: 'user' })))}
            {p.additional.length === 0 && empty('No other sections found, such as publications, languages or volunteering.')}
            {p.additional.length > 0 && (
              <ul className={s.items}>
                {p.additional.map((it, i) => (
                  <li className={s.item} key={i}>
                    <div className="field">
                      <label htmlFor={`add-h-${i}`}>Section</label>
                      <input id={`add-h-${i}`} className="input" value={it.heading} maxLength={120} onChange={(e) => edit((d) => { d.additional[i].heading = e.target.value; })} />
                    </div>
                    <div className="field">
                      <label htmlFor={`add-t-${i}`}>Detail</label>
                      <textarea id={`add-t-${i}`} className="textarea compact" rows={2} value={it.text} maxLength={2000} onChange={(e) => edit((d) => { d.additional[i].text = e.target.value; })} />
                    </div>
                    <div className={s.itemFoot}>
                      <Prov source={it.source} />
                      <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove other section item ${i + 1}`} onClick={() => edit((d) => { d.additional.splice(i, 1); })}>Remove</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={`${s.section} ${s.custom}`} aria-labelledby="h-cc">
            <div className={s.head}><h2 id="h-cc">Custom context</h2></div>
            <div className="field">
              <label htmlFor="cc">Anything the assistant should know about you</label>
              <textarea id="cc" className="textarea" rows={5} value={p.custom_context.text} maxLength={8000} onChange={(e) => edit((d) => { d.custom_context.text = e.target.value; })} />
              <span className="hint">Written by you. It is sent to the desktop app as your own words.</span>
            </div>
          </section>
        </div>
      </div>

      <div className={`save-bar ${s.saveBar}`} data-dirty={dirty}>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving...' : 'Save profile'}</button>
        {dirty && !msg && <span className="status" data-tone="warning">Unsaved changes</span>}
        {!dirty && !msg && <span className="meta">No unsaved changes</span>}
        {msg && <span className={msg.ok ? 'form-ok' : 'form-error'} role="status">{msg.text}</span>}
      </div>
    </div>
  );
}
