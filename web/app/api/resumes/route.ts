import { api, ApiError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { type ExtractionMethod, extractResume, MAX_FILE_BYTES } from '@/lib/resume-extract';
import { createResume } from '@/lib/resume-file';
import { driver, sha256 } from '@/lib/storage';

// OCR of a scan plus AI analysis can take most of a minute.
export const maxDuration = 60;

/**
 * multipart: `file` (pdf/docx/txt/md) or `text` (+ optional `name`). With the blob driver PDFs go
 * browser -> storage -> /api/resumes/finalize instead, because Functions accept 4.5 MB bodies at most.
 */
export const POST = api(async (req) => {
  const user = await requireUser();
  if (Number(req.headers.get('content-length') || 0) > MAX_FILE_BYTES + 64 * 1024) throw new ApiError(413, 'File is larger than 8 MB');
  const form = await req.formData().catch(() => null);
  if (!form) throw new ApiError(400, 'Expected a multipart form');

  const file = form.get('file');
  const pasted = form.get('text');
  const nameInput = String(form.get('name') ?? '').trim().slice(0, 120);

  let fileName: string;
  let ex: { mime: string; text: string; method: ExtractionMethod; keepBytes: boolean };
  let bytes: Buffer | null = null;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_FILE_BYTES) throw new ApiError(413, 'File is larger than 8 MB');
    const buf = Buffer.from(await file.arrayBuffer());
    fileName = file.name.slice(0, 200) || 'resume';
    if (driver() === 'blob' && /\.pdf$/i.test(fileName)) throw new ApiError(400, 'PDFs are uploaded directly to storage. Use the direct upload flow.');
    ex = await extractResume(buf, fileName);
    if (ex.keepBytes) bytes = buf;
  } else if (typeof pasted === 'string' && pasted.trim()) {
    if (pasted.length > 200_000) throw new ApiError(413, 'Pasted text is too long');
    fileName = 'pasted-text.txt';
    ex = { mime: 'text/plain', text: pasted.trim(), method: 'text', keepBytes: false };
  } else {
    throw new ApiError(400, 'Attach a PDF, Word (.docx), TXT or MD file, or paste text');
  }

  const name = nameInput || fileName.replace(/\.(pdf|docx|txt|md)$/i, '') || 'Resume';
  const stored = { mime: ex.mime, size: bytes ? bytes.length : Buffer.byteLength(ex.text), bytes, key: null, sha256: bytes ? sha256(bytes) : null };
  const { id } = await createResume(user.id, { name, fileName, text: ex.text, method: ex.method, file: stored });
  return { id };
});
