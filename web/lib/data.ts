import 'server-only';
import { one, query } from './db';
import { sha256 } from './auth';
import { parseStoredProfile, type Profile } from './profile';
import type { ParsedJd } from './jd';
import type { AiPrep, Comparison } from './prep';

// Every function takes the user id from the server session and puts it in the WHERE clause.

export interface ResumeSummary {
  id: string;
  name: string;
  file_name: string;
  mime: string;
  size_bytes: number;
  has_file: boolean;
  is_active: boolean;
  text_chars: number;
  created_at: Date;
  updated_at: Date;
}
export interface Resume extends ResumeSummary {
  extracted_text: string;
}

const RESUME_COLS = `id, name, file_name, mime, size_bytes, (file_bytes IS NOT NULL) AS has_file, is_active,
  length(extracted_text) AS text_chars, created_at, updated_at`;

export const listResumes = (uid: string) =>
  query<ResumeSummary>(`SELECT ${RESUME_COLS} FROM resumes WHERE user_id = $1 ORDER BY is_active DESC, created_at DESC`, [uid]);

export const getResume = (uid: string, id: string) =>
  one<Resume>(`SELECT ${RESUME_COLS}, extracted_text FROM resumes WHERE user_id = $1 AND id = $2`, [uid, id]);

export const getActiveResume = (uid: string) =>
  one<Resume>(`SELECT ${RESUME_COLS}, extracted_text FROM resumes WHERE user_id = $1 AND is_active`, [uid]);

export async function getProfile(uid: string, resumeId: string): Promise<{ profile: Profile; updated_at: Date } | null> {
  const row = await one<{ data: unknown; updated_at: Date }>(
    'SELECT data, updated_at FROM candidate_profiles WHERE user_id = $1 AND resume_id = $2',
    [uid, resumeId]
  );
  return row ? { profile: parseStoredProfile(row.data), updated_at: row.updated_at } : null;
}

export interface Jd {
  id: string;
  company: string;
  role: string;
  text: string;
  parsed: ParsedJd;
  resume_id: string | null;
  response_mode: string;
  created_at: Date;
  updated_at: Date;
}
const JD_COLS = 'id, company, role, text, parsed, resume_id, response_mode, created_at, updated_at';
export const listJds = (uid: string) =>
  query<Jd>(`SELECT ${JD_COLS} FROM job_descriptions WHERE user_id = $1 ORDER BY updated_at DESC`, [uid]);
export const getJd = (uid: string, id: string) =>
  one<Jd>(`SELECT ${JD_COLS} FROM job_descriptions WHERE user_id = $1 AND id = $2`, [uid, id]);

export interface Session {
  id: string;
  resume_id: string | null;
  jd_id: string | null;
  title: string;
  company: string;
  role: string;
  interview_type: string;
  response_mode: string;
  notes: string;
  status: 'draft' | 'ready' | 'completed';
  scheduled_at: Date | null;
  created_at: Date;
  updated_at: Date;
  resume_name: string | null;
  jd_label: string | null;
}
const SESSION_SQL = `SELECT s.id, s.resume_id, s.jd_id, s.title, s.company, s.role, s.interview_type, s.response_mode, s.notes,
  s.status, s.scheduled_at, s.created_at, s.updated_at, r.name AS resume_name,
  CASE WHEN j.id IS NULL THEN NULL ELSE trim(concat_ws(' - ', nullif(j.role, ''), nullif(j.company, ''))) END AS jd_label
  FROM interview_sessions s
  LEFT JOIN resumes r ON r.id = s.resume_id AND r.user_id = s.user_id
  LEFT JOIN job_descriptions j ON j.id = s.jd_id AND j.user_id = s.user_id`;
export const listSessions = (uid: string) => query<Session>(`${SESSION_SQL} WHERE s.user_id = $1 ORDER BY s.updated_at DESC`, [uid]);
export const getSession = (uid: string, id: string) => one<Session>(`${SESSION_SQL} WHERE s.user_id = $1 AND s.id = $2`, [uid, id]);

export interface PrepRow<T> {
  id: string;
  content: T;
  model: string | null;
  created_at: Date;
}
export async function latestPrep(uid: string, sessionId: string) {
  const rows = await query<PrepRow<unknown> & { kind: string }>(
    `SELECT DISTINCT ON (kind) id, kind, content, model, created_at FROM prep_results
     WHERE user_id = $1 AND session_id = $2 ORDER BY kind, created_at DESC`,
    [uid, sessionId]
  );
  return {
    comparison: (rows.find((r) => r.kind === 'comparison') as PrepRow<Comparison> | undefined) ?? null,
    ai: (rows.find((r) => r.kind === 'ai_prep') as PrepRow<AiPrep> | undefined) ?? null
  };
}

export interface DeviceToken {
  id: string;
  name: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
  linked_via: 'manual' | 'pkce';
}
export const listDeviceTokens = (uid: string) =>
  query<DeviceToken>(
    'SELECT id, name, prefix, created_at, last_used_at, revoked_at, expires_at, linked_via FROM device_tokens WHERE user_id = $1 ORDER BY created_at DESC',
    [uid]
  );

export const countOf = async (table: 'resumes' | 'job_descriptions' | 'interview_sessions', uid: string) =>
  Number((await one<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE user_id = $1`, [uid]))?.n ?? 0);

/** Context bundle the desktop app caches before a live session. */
export async function buildContextBundle(uid: string, sessionId: string | null) {
  const user = await one<{ active_session_id: string | null }>('SELECT active_session_id FROM users WHERE id = $1', [uid]);
  const sid = sessionId ?? user?.active_session_id ?? null;
  const session = sid ? await getSession(uid, sid) : null;
  if (sessionId && !session) return 'session_not_found' as const;

  const resume = session ? (session.resume_id ? await getResume(uid, session.resume_id) : null) : await getActiveResume(uid);
  const prof = resume ? await getProfile(uid, resume.id) : null;
  const jd = session?.jd_id ? await getJd(uid, session.jd_id) : null;
  if (!session && !resume) return 'no_context' as const;

  const stamps = [session?.updated_at, resume?.updated_at, prof?.updated_at, jd?.updated_at].filter(Boolean) as Date[];
  const body = {
    schema_version: 1,
    updated_at: new Date(Math.max(...stamps.map((d) => d.getTime()))).toISOString(),
    session: session && {
      id: session.id,
      title: session.title,
      status: session.status,
      interview_type: session.interview_type,
      notes: session.notes,
      scheduled_at: session.scheduled_at?.toISOString() ?? null
    },
    settings: {
      response_mode: session?.response_mode ?? jd?.response_mode ?? 'professional',
      company: session?.company || jd?.company || '',
      role: session?.role || jd?.role || ''
    },
    resume: resume && {
      id: resume.id,
      name: resume.name,
      updated_at: resume.updated_at.toISOString(),
      size: resume.size_bytes,
      has_pdf: resume.has_file,
      text: resume.extracted_text
    },
    // Reviewed profile: values the user edited win over extracted ones; each item carries its source.
    profile: prof?.profile ?? null,
    job_description: jd && { id: jd.id, company: jd.company, role: jd.role, text: jd.text, parsed: jd.parsed }
  };
  const version = sha256(JSON.stringify(body)).slice(0, 32);
  return { body: { version, ...body }, etag: `"${version}"` };
}
