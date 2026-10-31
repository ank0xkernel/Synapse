import { api, idParam, notFound, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { one, query } from '@/lib/db';
import { getProfile } from '@/lib/data';
import { applyProvenance, extractProfile, profileSchema } from '@/lib/profile';
import { z } from 'zod';

type P = { id: string };

/** Save edits. Provenance is recomputed on the server against what is stored. */
export const PUT = api<P>(async (req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  const stored = await getProfile(user.id, id);
  if (!stored) throw notFound();
  const incoming = await readJson(req, profileSchema, 256 * 1024);
  const next = applyProvenance(incoming, stored.profile);
  await query('UPDATE candidate_profiles SET data = $3, updated_at = now() WHERE user_id = $1 AND resume_id = $2', [
    user.id,
    id,
    JSON.stringify(next)
  ]);
  return { profile: next };
});

/** Re-extract from the current resume text, replacing all fields (including edits). */
export const POST = api<P>(async (req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  await readJson(req, z.object({ confirm: z.literal(true) }), 1024);
  const r = await one<{ extracted_text: string }>('SELECT extracted_text FROM resumes WHERE user_id = $1 AND id = $2', [user.id, id]);
  if (!r) throw notFound();
  const profile = extractProfile(r.extracted_text);
  await query(
    `INSERT INTO candidate_profiles (resume_id, user_id, data) VALUES ($1, $2, $3)
     ON CONFLICT (resume_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [id, user.id, JSON.stringify(profile)]
  );
  return { profile };
});
