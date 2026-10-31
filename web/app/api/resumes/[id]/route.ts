import { z } from 'zod';
import { api, idParam, notFound, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { one, query } from '@/lib/db';
import { blob } from '@/lib/storage';

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
  const row = await one<{ was_active: boolean; storage_key: string | null }>(
    'DELETE FROM resumes WHERE user_id = $1 AND id = $2 RETURNING is_active AS was_active, storage_key',
    [user.id, id]
  );
  if (!row) throw notFound();
  // The row is gone first, so a failed blob delete leaves an unreachable object, never a dangling record.
  if (row.storage_key) {
    await blob().remove(row.storage_key).catch((e) => console.error(JSON.stringify({ level: 'warn', msg: 'blob delete failed', err: String(e?.message ?? e) })));
  }
  if (row.was_active) {
    // Promote the newest remaining resume so "active" never silently points nowhere.
    await query(
      `UPDATE resumes SET is_active = true WHERE id = (SELECT id FROM resumes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
      [user.id]
    );
  }
  return {};
});
