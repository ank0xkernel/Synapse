import { z } from 'zod';
import { api, ApiError, idParam, notFound, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { one } from '@/lib/db';
import { getJd, getProfile, getSession } from '@/lib/data';
import { AiUnavailable, aiConfigured, compare, generateAiPrep } from '@/lib/prep';

export const maxDuration = 60;

const body = z.object({ mode: z.enum(['deterministic', 'ai']) });

export const POST = api<{ id: string }>(async (req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  const { mode } = await readJson(req, body, 1024);
  const session = await getSession(user.id, id);
  if (!session) throw notFound();

  const prof = session.resume_id ? await getProfile(user.id, session.resume_id) : null;
  const jd = session.jd_id ? await getJd(user.id, session.jd_id) : null;
  if (!prof) throw new ApiError(400, 'Attach a resume to this session first');
  if (!jd) throw new ApiError(400, 'Attach a job description to this session first');
  const comparison = compare(prof.profile, jd.parsed);

  if (mode === 'deterministic') {
    const row = await one<{ created_at: Date }>(
      `INSERT INTO prep_results (user_id, session_id, kind, source, content) VALUES ($1,$2,'comparison','deterministic',$3) RETURNING created_at`,
      [user.id, id, JSON.stringify(comparison)]
    );
    return { comparison, created_at: row!.created_at };
  }

  if (!aiConfigured()) throw new ApiError(503, 'AI preparation needs GEMINI_API_KEY on the server');
  try {
    const out = await generateAiPrep({
      profile: prof.profile,
      jdText: jd.text,
      company: session.company || jd.company,
      role: session.role || jd.role,
      interviewType: session.interview_type,
      notes: session.notes,
      comparison
    });
    const row = await one<{ created_at: Date }>(
      `INSERT INTO prep_results (user_id, session_id, kind, source, model, content) VALUES ($1,$2,'ai_prep','ai',$3,$4) RETURNING created_at`,
      [user.id, id, out.model, JSON.stringify(out.content)]
    );
    return { model: out.model, created_at: row!.created_at };
  } catch (e) {
    if (e instanceof AiUnavailable) throw new ApiError(502, e.message);
    throw e;
  }
});
