import 'server-only';
import { one, withTx } from './db';
import { ApiError, notFound } from './http';
import { PARSER_VERSION, extractPdfText } from './resume-extract';
import { extractProfile, mergeReprocessed, parseStoredProfile } from './profile';
import { blob, fileUrl, sha256 } from './storage';

type Q = Parameters<Parameters<typeof withTx>[0]>[0];

/**
 * A resume's PDF for its owner, or 404. Files in private Blob are never proxied (Functions cap
 * responses at 4.5 MB): the caller is redirected to a signed URL that expires in two minutes.
 * Used by both the cookie and the device-token routes.
 */
export async function pdfResponse(userId: string, resumeId: string): Promise<Response> {
  const row = await one<{ file_bytes: Buffer | null; mime: string; storage_driver: string; storage_key: string | null }>(
    'SELECT file_bytes, mime, storage_driver, storage_key FROM resumes WHERE user_id = $1 AND id = $2',
    [userId, resumeId]
  );
  if (!row || row.mime !== 'application/pdf') throw notFound();
  if (row.storage_driver === 'blob' && row.storage_key) {
    return new Response(null, {
      status: 302,
      headers: { Location: await fileUrl(row.storage_key), 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
    });
  }
  if (!row.file_bytes) throw notFound();
  return new Response(new Uint8Array(row.file_bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="resume.pdf"',
      'Content-Length': String(row.file_bytes.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export interface StoredFile {
  mime: string;
  size: number;
  bytes: Buffer | null;
  key: string | null;
  sha256: string | null;
}

/** Rebuild the parsed profile from text, keeping every item the user wrote or edited. */
async function saveMergedProfile(q: Q, userId: string, resumeId: string, text: string) {
  const [old] = await q<{ data: unknown }>('SELECT data FROM candidate_profiles WHERE user_id = $1 AND resume_id = $2 FOR UPDATE', [userId, resumeId]);
  const fresh = extractProfile(text);
  const next = old ? mergeReprocessed(parseStoredProfile(old.data), fresh) : fresh;
  await q(
    `INSERT INTO candidate_profiles (resume_id, user_id, data) VALUES ($1, $2, $3)
     ON CONFLICT (resume_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [resumeId, userId, JSON.stringify(next)]
  );
}

/** Insert a resume and its profile in one transaction. The same storage key twice returns the existing row. */
export async function createResume(
  userId: string,
  p: { name: string; fileName: string; text: string; file: StoredFile }
): Promise<{ id: string; created: boolean }> {
  return withTx(async (q) => {
    const [row] = await q<{ id: string }>(
      `INSERT INTO resumes (user_id, name, file_name, mime, size_bytes, file_bytes, storage_driver, storage_key, file_sha256,
         extracted_text, is_active, parse_status, parser_version, extracted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOT EXISTS (SELECT 1 FROM resumes WHERE user_id = $1 AND is_active), 'ok', $11, now())
       ON CONFLICT (storage_key) WHERE storage_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [userId, p.name, p.fileName, p.file.mime, p.file.size, p.file.bytes, p.file.key ? 'blob' : 'db', p.file.key, p.file.sha256, p.text, PARSER_VERSION]
    );
    if (!row) {
      const [existing] = await q<{ id: string }>('SELECT id FROM resumes WHERE user_id = $1 AND storage_key = $2', [userId, p.file.key]);
      if (!existing) throw new ApiError(409, 'That upload belongs to another account');
      return { id: existing.id, created: false };
    }
    await q('INSERT INTO candidate_profiles (resume_id, user_id, data) VALUES ($1, $2, $3)', [row.id, userId, JSON.stringify(extractProfile(p.text))]);
    return { id: row.id, created: true };
  });
}

/** Swap the stored PDF of an existing resume. Returns the old blob key to delete, or null. */
export async function replaceResumeFile(
  userId: string,
  id: string,
  p: { fileName: string; text: string; file: StoredFile }
): Promise<{ oldKey: string | null }> {
  const oldKey = await withTx(async (q) => {
    const [cur] = await q<{ storage_key: string | null }>('SELECT storage_key FROM resumes WHERE user_id = $1 AND id = $2 FOR UPDATE', [userId, id]);
    if (!cur) throw notFound();
    if (p.file.key && cur.storage_key === p.file.key) return null; // finalize repeated: already applied
    await q(
      `UPDATE resumes SET file_name = $3, mime = $4, size_bytes = $5, file_bytes = $6, storage_driver = $7, storage_key = $8, file_sha256 = $9,
         extracted_text = $10, parse_status = 'ok', parse_error = NULL, parser_version = $11, extracted_at = now(), updated_at = now()
       WHERE user_id = $1 AND id = $2`,
      [userId, id, p.fileName, p.file.mime, p.file.size, p.file.bytes, p.file.key ? 'blob' : 'db', p.file.key, p.file.sha256, p.text, PARSER_VERSION]
    );
    await saveMergedProfile(q, userId, id, p.text);
    return cur.storage_key;
  });
  return { oldKey };
}

/**
 * Re-extract from the stored original PDF (or from the saved text for pasted resumes) and rebuild
 * the profile, keeping user-edited items. A failure is recorded on the row and the previous text and
 * profile stay untouched, so a bad reprocess never destroys good data.
 */
export async function reprocessResume(userId: string, id: string): Promise<void> {
  const row = await one<{ mime: string; file_bytes: Buffer | null; storage_driver: string; storage_key: string | null; extracted_text: string }>(
    'SELECT mime, file_bytes, storage_driver, storage_key, extracted_text FROM resumes WHERE user_id = $1 AND id = $2',
    [userId, id]
  );
  if (!row) throw notFound();

  let text = row.extracted_text;
  let sha: string | null = null;
  try {
    if (row.mime === 'application/pdf') {
      const bytes = row.storage_driver === 'blob' && row.storage_key ? await blob().read(row.storage_key) : row.file_bytes;
      if (!bytes) throw new ApiError(404, 'The original PDF is missing, so it cannot be reprocessed. Upload it again with Replace file.');
      text = await extractPdfText(bytes);
      sha = sha256(bytes);
    }
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) {
      await one(
        `UPDATE resumes SET parse_status = 'failed', parse_error = $3, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING id`,
        [userId, id, err.message]
      );
    }
    throw err;
  }

  await withTx(async (q) => {
    await q(
      `UPDATE resumes SET extracted_text = $3, file_sha256 = COALESCE($4, file_sha256), parse_status = 'ok', parse_error = NULL,
         parser_version = $5, extracted_at = now(), updated_at = now() WHERE user_id = $1 AND id = $2`,
      [userId, id, text, sha, PARSER_VERSION]
    );
    await saveMergedProfile(q, userId, id, text);
  });
}
