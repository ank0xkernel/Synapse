import { api, ApiError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { one, query } from '@/lib/db';
import { extractResume, MAX_FILE_BYTES } from '@/lib/resume-extract';
import { extractProfile } from '@/lib/profile';

export const maxDuration = 30;

/** multipart: `file` (pdf/txt/md) or `text` (+ optional `name`). */
export const POST = api(async (req) => {
  const user = await requireUser();
  if (Number(req.headers.get('content-length') || 0) > MAX_FILE_BYTES + 64 * 1024) throw new ApiError(413, 'File is larger than 8 MB');
  const form = await req.formData().catch(() => null);
  if (!form) throw new ApiError(400, 'Expected a multipart form');

  const file = form.get('file');
  const pasted = form.get('text');
  const nameInput = String(form.get('name') ?? '').trim().slice(0, 120);

  let fileName: string;
  let ex: { mime: string; text: string; keepBytes: boolean };
  let bytes: Buffer | null = null;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_FILE_BYTES) throw new ApiError(413, 'File is larger than 8 MB');
    const buf = Buffer.from(await file.arrayBuffer());
    fileName = file.name.slice(0, 200) || 'resume';
    ex = await extractResume(buf, fileName);
    if (ex.keepBytes) bytes = buf;
  } else if (typeof pasted === 'string' && pasted.trim()) {
    if (pasted.length > 200_000) throw new ApiError(413, 'Pasted text is too long');
    fileName = 'pasted-text.txt';
    ex = { mime: 'text/plain', text: pasted.trim(), keepBytes: false };
  } else {
    throw new ApiError(400, 'Attach a PDF, TXT or MD file, or paste text');
  }

  const name = nameInput || fileName.replace(/\.(pdf|txt|md)$/i, '') || 'Resume';
  const hasActive = await one('SELECT 1 FROM resumes WHERE user_id = $1 AND is_active', [user.id]);
  const row = await one<{ id: string }>(
    `INSERT INTO resumes (user_id, name, file_name, mime, size_bytes, file_bytes, extracted_text, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [user.id, name, fileName, ex.mime, bytes ? bytes.length : Buffer.byteLength(ex.text), bytes, ex.text, !hasActive]
  );
  await query('INSERT INTO candidate_profiles (resume_id, user_id, data) VALUES ($1, $2, $3)', [
    row!.id,
    user.id,
    JSON.stringify(extractProfile(ex.text))
  ]);
  return { id: row!.id };
});
