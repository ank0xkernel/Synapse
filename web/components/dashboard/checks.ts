import type { DeviceToken, ResumeSummary, Session } from '@/lib/data';
import type { Profile } from '@/lib/profile';
import { bestSync } from './sync';

/**
 * The cloud's states for one link in the chain the desktop agent depends on:
 * absent (nothing yet), forming (exists, not finished), vivid (in place), dispersed (stale or broken).
 */
export type Phase = 'absent' | 'forming' | 'vivid' | 'dispersed';

export interface Check {
  id: 'resume' | 'profile' | 'session' | 'jd' | 'link' | 'context';
  label: string;
  phase: Phase;
  state: string;
  /** Present when the user has something to do here. `blocking` steps count toward "steps left". */
  action?: { label: string; href: string; blocking: boolean };
  detail?: string;
}

const READ_BY: Record<ResumeSummary['extraction_method'], string> = {
  pdf: 'Read from the PDF',
  ocr: 'Read from scanned pages',
  docx: 'Read from the Word file',
  text: 'Taken as pasted'
};

/** Any item the user wrote or corrected. The profile has no "reviewed" flag, so edits are the only honest signal. */
export const hasUserEdits = (p: Profile) =>
  !!p.custom_context.text ||
  [p.summary, p.contact, p.additional, p.education, p.experience, p.projects, p.skills, p.achievements, p.certifications].some((list) =>
    list.some((item) => item.source === 'user')
  );

export function buildChecks(input: {
  resume: ResumeSummary | null;
  profile: Profile | null;
  session: Session | null;
  sessionCount: number;
  hasJd: boolean;
  tokens: DeviceToken[];
  currentVersion: string | null;
  now: number;
}): Check[] {
  const { resume, profile, session, tokens, currentVersion, now } = input;
  const checks: Check[] = [];

  if (!resume) {
    checks.push({
      id: 'resume', label: 'Resume', phase: 'absent',
      state: session ? 'This session has no resume' : 'No resume yet',
      action: session
        ? { label: 'Choose a resume for this session', href: `/sessions/${session.id}`, blocking: true }
        : { label: 'Upload your resume', href: '/resumes', blocking: true }
    });
  } else if (resume.parse_status === 'failed') {
    checks.push({ id: 'resume', label: 'Resume', phase: 'dispersed', state: `${resume.name} could not be read`, action: { label: 'Retry or replace the file', href: `/resumes/${resume.id}`, blocking: true } });
  } else if (resume.parse_status === 'needs_reprocess') {
    checks.push({ id: 'resume', label: 'Resume', phase: 'dispersed', state: `${resume.name}, read by an older parser`, action: { label: 'Reprocess it', href: `/resumes/${resume.id}`, blocking: false } });
  } else {
    checks.push({
      id: 'resume', label: 'Resume', phase: 'vivid', state: resume.name,
      detail: `${READ_BY[resume.extraction_method]}, analysed ${resume.analysis_method === 'ai' ? 'with AI' : 'by rules'}`
    });
  }

  if (resume) {
    const href = `/profile?resume=${resume.id}`;
    checks.push(!profile
      ? { id: 'profile', label: 'Candidate profile', phase: 'absent', state: 'Not built yet', action: { label: 'Open the profile', href, blocking: false } }
      : hasUserEdits(profile)
        ? { id: 'profile', label: 'Candidate profile', phase: 'vivid', state: 'Includes your corrections' }
        : { id: 'profile', label: 'Candidate profile', phase: 'forming', state: 'Extracted, not edited by you yet', action: { label: 'Review the profile', href, blocking: false } });
  }

  checks.push(session
    ? { id: 'session', label: 'Interview session', phase: 'vivid', state: session.title }
    : {
        id: 'session', label: 'Interview session', phase: 'absent', state: 'None loaded in the desktop app',
        action: input.sessionCount > 0 ? { label: 'Load a session', href: '/sessions', blocking: true } : { label: 'Create a session', href: '/sessions/new', blocking: true }
      });

  checks.push(input.hasJd && session
    ? { id: 'jd', label: 'Job description', phase: 'vivid', state: session.jd_label || 'Attached' }
    : {
        id: 'jd', label: 'Job description', phase: 'absent', state: session ? 'Not attached to this session' : 'Comes with a session',
        action: session ? { label: 'Attach a job description', href: `/sessions/${session.id}`, blocking: true } : undefined
      });

  const sync = bestSync(tokens, currentVersion, now);
  checks.push(sync === 'none'
    ? { id: 'link', label: 'Desktop link', phase: 'absent', state: 'No Mac linked', action: { label: 'Link your Mac', href: '/desktop', blocking: true } }
    : { id: 'link', label: 'Desktop link', phase: 'vivid', state: 'Linked' });

  const context = 'Context on your Mac';
  if (sync === 'latest') checks.push({ id: 'context', label: context, phase: 'vivid', state: 'Has your latest context' });
  else if (sync === 'older') checks.push({ id: 'context', label: context, phase: 'dispersed', state: 'Has an older copy', detail: 'It updates when the app next checks: select Refresh, or start listening.' });
  else if (sync === 'never') checks.push({ id: 'context', label: context, phase: 'forming', state: 'Not fetched yet', detail: 'The app fetches it when you select Refresh or start listening.' });
  else checks.push({ id: 'context', label: context, phase: 'absent', state: sync === 'none' ? 'Waiting for a linked Mac' : 'Nothing to send yet' });

  return checks;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536e6], ['month', 2592e6], ['week', 6048e5], ['day', 864e5], ['hour', 36e5], ['minute', 6e4]];
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "in 3 days", "2 hours ago". Rendered per request, so it is true when the page loads. */
export function relative(d: Date, now: number) {
  const diff = d.getTime() - now;
  for (const [unit, ms] of UNITS) if (Math.abs(diff) >= ms) return rtf.format(Math.trunc(diff / ms), unit);
  return diff >= 0 ? 'within a minute' : 'just now';
}
