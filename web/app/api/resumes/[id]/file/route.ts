import { api, ApiError, idParam } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { extractPdfText, MAX_FILE_BYTES } from '@/lib/resume-extract';
import { pdfResponse, replaceResumeFile } from '@/lib/resume-file';
import { driver, sha256 } from '@/lib/storage';

export const maxDuration = 30;

export const GET = api<{ id: string }>(async (_req, { params }) => {
  const user = await requireUser();
  return pdfResponse(user.id, idParam((await params).id));
});

/**
 * Replace the PDF of an existing resume (db driver, multipart `file`, under the 4.5 MB Function limit).
 * With the blob driver use POST /api/resumes/finalize with `replaceId`.
 */
export const PUT = api<{ id: string }>(async (req, { params }) => {
  const user = await requireUser();
  const id = idParam((await params).id);
  if (driver() !== 'db') throw new ApiError(400, 'Use the direct upload flow to replace the file.');
  if (Number(req.headers.get('content-length') || 0) > MAX_FILE_BYTES + 64 * 1024) throw new ApiError(413, 'File is larger than 8 MB');
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File) || file.size === 0) throw new ApiError(400, 'Attach a PDF file');
  const buf = Buffer.from(await file.arrayBuffer());
  const text = await extractPdfText(buf);
  await replaceResumeFile(user.id, id, {
    fileName: file.name.slice(0, 200) || 'resume.pdf',
    text,
    file: { mime: 'application/pdf', size: buf.length, bytes: buf, key: null, sha256: sha256(buf) }
  });
  return {};
});
