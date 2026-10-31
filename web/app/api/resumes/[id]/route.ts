import { z } from 'zod';
import { api, idParam, notFound, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { one, query } from '@/lib/db';

type P = { id: string };

const patch = z
  .object({ name: z.string().trim().min(1).max(120), extractedText: z.string().trim().min(1).max(200_000) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

export const PATCH = api<P>(async (req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  const b = await readJson(req, patch, 400 * 1024);
  const row = await one(
    `UPDATE resumes SET name = COALESCE($3, name), extracted_text = COALESCE($4, extracted_text), updated_at = now()
     WHERE user_id = $1 AND id = $2 RETURNING id`,
    [user.id, id, b.name ?? null, b.extractedText ?? null]
  );
  if (!row) throw notFound();
  return {};
});

export const DELETE = api<P>(async (_req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  const row = await one<{ was_active: boolean }>('DELETE FROM resumes WHERE user_id = $1 AND id = $2 RETURNING is_active AS was_active', [
    user.id,
    id
  ]);
  if (!row) throw notFound();
  if (row.was_active) {
    // Promote the newest remaining resume so "active" never silently points nowhere.
    await query(
      `UPDATE resumes SET is_active = true WHERE id = (SELECT id FROM resumes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
      [user.id]
    );
  }
  return {};
});
