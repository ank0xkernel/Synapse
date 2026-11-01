import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { listSessions, type Session } from '@/lib/data';
import { fmtDate, STATUS_LABEL, STATUS_TONE } from '@/lib/format';
import { INTERVIEW_TYPES, RESPONSE_MODES } from '@/lib/constants';
import Icon from '@/components/Icon';
import s from './sessions.module.css';

export const metadata: Metadata = { title: 'Sessions' };

// Same zone as lib/format: every date on the site is UTC.
const day = new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'UTC' });
const monthYear = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });

export default async function Sessions() {
  const user = await requirePageUser();
  const sessions = await listSessions(user.id);
  const now = Date.now();
  const at = (x: Session) => x.scheduled_at?.getTime() ?? null;
  const isPast = (x: Session) => x.status === 'completed' || (at(x) !== null && at(x)! < now);

  const upcoming = sessions.filter((x) => !isPast(x) && at(x) !== null).sort((a, b) => at(a)! - at(b)!);
  const unscheduled = sessions.filter((x) => !isPast(x) && at(x) === null);
  const past = sessions.filter(isPast).sort((a, b) => (at(b) ?? b.updated_at.getTime()) - (at(a) ?? a.updated_at.getTime()));
  const loaded = sessions.find((x) => x.id === user.activeSessionId);

  const groups = [
    { id: 'upcoming', title: 'Upcoming', note: 'Scheduled, soonest first.', items: upcoming },
    { id: 'unscheduled', title: 'Not scheduled', note: 'No date set yet.', items: unscheduled },
    { id: 'past', title: 'Past and completed', note: 'Marked completed, or the scheduled time has passed.', items: past }
  ].filter((g) => g.items.length > 0);

  return (
    <div className="stack-lg">
      <div className="page-head page-head-row">
        <div>
          <h1>Sessions</h1>
          <p>One session per interview: which resume, which job, how you want answers, and your own notes.</p>
        </div>
        {sessions.length > 0 && <Link className="btn btn-primary" href="/sessions/new"><Icon name="plus" size={16} />New session</Link>}
      </div>

      {sessions.length === 0 ? (
        <section className={s.empty} aria-labelledby="sessions-empty">
          <h2 id="sessions-empty">No sessions yet</h2>
          <p>A session tells the desktop app what to use for one interview. You choose:</p>
          <dl className={s.emptyList}>
            <div><dt>Material</dt><dd>The resume answers are grounded in, and the job description they aim at.</dd></div>
            <div><dt>Answer style</dt><dd>Quick, Professional, Technical, STAR or Detailed.</dd></div>
            <div><dt>Context</dt><dd>Your own notes about the interviewers, the team and what to stress.</dd></div>
          </dl>
          <p>Load a session in the desktop app and it fetches all of this before the call.</p>
          <Link className="btn btn-primary" href="/sessions/new"><Icon name="plus" size={16} />Create your first session</Link>
        </section>
      ) : (
        <>
          <div className={`${s.loaded} ${loaded ? 'fringe' : ''}`}>
            <Icon name="desktop" size={20} />
            {loaded ? (
              <p>The desktop app loads <Link href={`/sessions/${loaded.id}`}>{loaded.title}</Link>.</p>
            ) : (
              <p>No session is loaded in the desktop app. Open a session and choose Load in desktop app.</p>
            )}
          </div>

          {groups.map((g) => (
            <section key={g.id} className={s.group} aria-labelledby={`g-${g.id}`}>
              <div className={s.groupHead}>
                <h2 id={`g-${g.id}`}>{g.title}</h2>
                <span className={s.count}>{g.items.length}</span>
                <p>{g.note}</p>
              </div>
              <ol className={s.timeline}>
                {g.items.map((x) => {
                  const isLoaded = x.id === user.activeSessionId;
                  const tone = STATUS_TONE[x.status];
                  return (
                    <li key={x.id} className={s.entry} data-loaded={isLoaded} data-past={g.id === 'past'}>
                      <div className={s.when}>
                        {x.scheduled_at ? (
                          <time dateTime={x.scheduled_at.toISOString()}>
                            <span className={s.day}>{day.format(x.scheduled_at)}</span>
                            <span className={s.month}>{monthYear.format(x.scheduled_at)}</span>
                            <span className={s.time}>{time.format(x.scheduled_at)} UTC</span>
                          </time>
                        ) : (
                          <span className={s.noDate}>No date<span className={s.month}>edited {fmtDate(x.updated_at)}</span></span>
                        )}
                      </div>
                      <span className={s.node} aria-hidden="true" />
                      <div className={s.body}>
                        <div className={s.titleRow}>
                          <Link className={s.title} href={`/sessions/${x.id}`}>{x.title}</Link>
                          <span className={s.statuses}>
                            {isLoaded && <span className="status" data-tone="accent">Loaded by desktop</span>}
                            <span className="status" data-tone={tone === 'neutral' ? undefined : tone}>{STATUS_LABEL[x.status]}</span>
                          </span>
                        </div>
                        <p className={s.role}>{[x.role, x.company].filter(Boolean).join(' at ') || 'No role set'}</p>
                        <ul className={s.facts}>
                          <li>{INTERVIEW_TYPES.find((t) => t.id === x.interview_type)?.label ?? x.interview_type} interview</li>
                          <li>{RESPONSE_MODES.find((m) => m.id === x.response_mode)?.label ?? x.response_mode} answers</li>
                          <li data-missing={!x.resume_name}>{x.resume_name ?? 'No resume'}</li>
                          <li data-missing={!x.jd_label}>{x.jd_label ?? 'No job description'}</li>
                        </ul>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
