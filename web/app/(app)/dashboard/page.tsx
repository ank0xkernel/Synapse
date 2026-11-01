import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { buildContextBundle, countOf, getActiveResume, getProfile, getResume, getSession, listDeviceTokens, listSessions, type Session } from '@/lib/data';
import { fmtDateTime, STATUS_LABEL, STATUS_TONE } from '@/lib/format';
import { INTERVIEW_TYPES, RESPONSE_MODES } from '@/lib/constants';
import Icon from '@/components/Icon';
import PostButton from '@/components/PostButton';
import FirstRun from '@/components/dashboard/FirstRun';
import Readiness from '@/components/dashboard/Readiness';
import { buildChecks, relative } from '@/components/dashboard/checks';
import { accessOf } from '@/components/dashboard/sync';
import s from '@/components/dashboard/dashboard.module.css';

export const metadata: Metadata = { title: 'Dashboard' };

const tone = (st: Session['status']) => (STATUS_TONE[st] === 'neutral' ? undefined : STATUS_TONE[st]);
const typeLabel = (id: string) => INTERVIEW_TYPES.find((t) => t.id === id)?.label ?? id;
const modeLabel = (id: string) => RESPONSE_MODES.find((m) => m.id === id)?.label ?? id;

export default async function Dashboard() {
  const user = await requirePageUser();
  const now = Date.now();
  const [active, session, sessions, tokens, bundle, resumeCount] = await Promise.all([
    getActiveResume(user.id),
    user.activeSessionId ? getSession(user.id, user.activeSessionId) : null,
    listSessions(user.id),
    listDeviceTokens(user.id),
    buildContextBundle(user.id, null),
    countOf('resumes', user.id)
  ]);

  if (resumeCount === 0 && sessions.length === 0) {
    return <FirstRun linked={tokens.some((t) => accessOf(t, now) === 'active')} />;
  }

  // The resume the desktop actually receives: the loaded session's, or the active one when no session is loaded.
  const resumeId = session ? session.resume_id : active?.id ?? null;
  const [resume, prof] = await Promise.all([
    !resumeId ? null : resumeId === active?.id ? active : getResume(user.id, resumeId),
    resumeId ? getProfile(user.id, resumeId) : null
  ]);
  const checks = buildChecks({
    resume,
    profile: prof?.profile ?? null,
    session,
    sessionCount: sessions.length,
    hasJd: !!session?.jd_id,
    tokens,
    currentVersion: typeof bundle === 'string' ? null : bundle.body.version,
    now
  });

  const blocking = checks.filter((c) => c.action?.blocking);
  const context = checks.find((c) => c.id === 'context');
  const ready = blocking.length === 0 && context?.phase === 'vivid';
  const [headline, sub] = blocking.length > 0
    ? [`${blocking.length} ${blocking.length === 1 ? 'step' : 'steps'} before your Mac is ready`, 'The desktop agent answers only from the material in this chain. Each open step links to where you finish it.']
    : context?.phase === 'dispersed'
      ? ['Your Mac has an older copy of your context', context.detail ?? '']
      : context?.phase === 'forming'
        ? ['Your Mac is linked but has not fetched your context', context.detail ?? '']
        : ['Your Mac is ready for your next interview', `It has the latest context for ${session?.title ?? 'your session'}.`];
  const next = blocking[0]?.action ?? (ready && session ? { label: 'Open preparation', href: `/prep/${session.id}` } : null);

  const future = sessions
    .filter((x) => x.id !== session?.id && x.status !== 'completed' && x.scheduled_at && x.scheduled_at.getTime() > now)
    .sort((a, b) => a.scheduled_at!.getTime() - b.scheduled_at!.getTime());
  // With nothing loaded, offer the sessions most likely to be next: scheduled first, then the latest open drafts.
  const candidates = session ? [] : [...future, ...sessions.filter((x) => x.status !== 'completed' && !x.scheduled_at)].slice(0, 3);
  const later = session ? future.slice(0, 4) : [];

  return (
    <div className={s.page}>
      <header className={s.head}>
        <div className={s.headText}>
          <h1>{headline}</h1>
          <p>{sub}</p>
        </div>
        {next && <Link className="btn btn-primary btn-lg" href={next.href}>{next.label}<Icon name="arrow" size={18} /></Link>}
      </header>

      <div className={s.board}>
        <section className={`${s.focal}${ready ? ' fringe' : ''}`} aria-labelledby="next-interview">
          {session ? (
            <>
              <div className={s.focalTop}>
                <span className="status" data-tone="accent">Loaded in the desktop app</span>
                <span className="status" data-tone={tone(session.status)}>{STATUS_LABEL[session.status]}</span>
              </div>
              <h2 id="next-interview" className={s.focalTitle}>{session.title}</h2>
              <p className={s.focalMeta}>
                {[session.role && session.company ? `${session.role} at ${session.company}` : session.role || session.company, `${typeLabel(session.interview_type)} interview`].filter(Boolean).join(' · ')}
              </p>
              <div className={s.when}>
                <Icon name="clock" size={20} className={s.whenIcon} />
                {session.scheduled_at ? (
                  <p>
                    <span className={s.whenRel}>{relative(session.scheduled_at, now)}</span>
                    <span className={`${s.whenAbs} num`}>{fmtDateTime(session.scheduled_at)}</span>
                  </p>
                ) : (
                  <p>
                    <span className={s.whenRel}>No date set</span>
                    <Link className={s.whenAbs} href={`/sessions/${session.id}`}>Add the interview time</Link>
                  </p>
                )}
              </div>
              <dl className={s.uses}>
                <div><dt>Resume</dt><dd>{session.resume_id ? <Link href={`/resumes/${session.resume_id}`}>{session.resume_name}</Link> : <span className={s.none}>None chosen</span>}</dd></div>
                <div><dt>Job description</dt><dd>{session.jd_id ? <Link href={`/jobs/${session.jd_id}`}>{session.jd_label || 'Untitled'}</Link> : <span className={s.none}>None attached</span>}</dd></div>
                <div><dt>Answer style</dt><dd>{modeLabel(session.response_mode)}</dd></div>
              </dl>
              <div className={s.focalActions}>
                <Link className="btn" href={`/sessions/${session.id}`}><Icon name="edit" size={16} />Edit session</Link>
                <Link className="btn btn-ghost" href={`/prep/${session.id}`}><Icon name="prep" size={16} />Preparation</Link>
              </div>
            </>
          ) : (
            <>
              <h2 id="next-interview" className={s.focalTitle}>No interview loaded</h2>
              <p className={s.focalLead}>
                {active
                  ? <>Until you load a session, the desktop app answers from your active resume, <Link href={`/resumes/${active.id}`}>{active.name}</Link>, with no job description.</>
                  : 'Until you load a session, the desktop app has nothing to answer from.'}
              </p>
              {candidates.length > 0 ? (
                <ul className={s.agenda} aria-label="Sessions you can load">
                  {candidates.map((x) => <AgendaRow key={x.id} x={x} now={now} />)}
                </ul>
              ) : (
                <div className={s.focalActions}>
                  <Link className="btn btn-primary" href="/sessions/new"><Icon name="plus" size={16} />Create a session</Link>
                </div>
              )}
            </>
          )}
        </section>

        <section className={s.side} aria-labelledby="readiness">
          <h2 id="readiness">What the desktop agent will use</h2>
          <Readiness checks={checks} />
        </section>
      </div>

      {later.length > 0 && (
        <section className={s.later} aria-labelledby="later">
          <div className={s.laterHead}>
            <h2 id="later">Also on your calendar</h2>
            <Link href="/sessions">All sessions</Link>
          </div>
          <ul className={s.agenda}>
            {later.map((x) => <AgendaRow key={x.id} x={x} now={now} />)}
          </ul>
        </section>
      )}
    </div>
  );
}

function AgendaRow({ x, now }: { x: Session; now: number }) {
  return (
    <li className={s.row}>
      {x.scheduled_at ? (
        <time className={s.date} dateTime={x.scheduled_at.toISOString()}>
          <span>{x.scheduled_at.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}</span>
          <b className="num">{x.scheduled_at.getUTCDate()}</b>
        </time>
      ) : (
        <span className={s.date} data-empty="true"><span>No</span><b>date</b></span>
      )}
      <div className={s.rowBody}>
        <Link className={s.rowTitle} href={`/sessions/${x.id}`}>{x.title}</Link>
        <span className={s.rowMeta}>
          {x.scheduled_at ? `${relative(x.scheduled_at, now)} · ${fmtDateTime(x.scheduled_at)}` : 'Not scheduled'}
        </span>
      </div>
      <span className="status" data-tone={tone(x.status)}>{STATUS_LABEL[x.status]}</span>
      <div className={s.rowAction}>
        <PostButton small label="Load in desktop app" url={`/api/sessions/${x.id}/activate`} />
      </div>
    </li>
  );
}
