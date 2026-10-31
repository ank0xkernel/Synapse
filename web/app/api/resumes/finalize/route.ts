import { z } from 'zod';
import { api, ApiError, idParam, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { extractPdfText } from '@/lib/resume-extract';
import { createResume, replaceResumeFile } from '@/lib/resume-file';
import { blob, driver, sha256 } from '@/lib/storage';
import { finalizeUpload } from '@/lib/storage-core';

export const maxDuration = 60;

const body = z.object({
  pathname: z.string().max(300),
  fileName: z.string().trim().max(200).default('resume.pdf'),
  name: z.string().trim().max(120).default(''),
  replaceId: z.string().optional()
});

/**
 * After the browser has uploaded straight to private Blob: verify the object is this user's, is a real
 * PDF within 8 MB and has text, then save the row. Finalizing the same pathname twice returns the same
 * resume. Rejected uploads are deleted from storage.
 */
export const POST = api(async (req) => {
  const user = await requireUser();
  if (driver() !== 'blob') throw new ApiError(404, 'Direct upload is not enabled');
  const b = await readJson(req, body, 4096);
  const replaceId = b.replaceId ? idParam(b.replaceId) : null;
  const fileName = b.fileName.replace(/[\r\n]/g, ' ') || 'resume.pdf';
  const store = blob();

  const out = await finalizeUpload(
    user.id,
    b.pathname,
    {
      read: (k) => store.read(k),
      remove: (k) => store.remove(k),
      extract: extractPdfText,
      save: async ({ key, bytes, sha256: sha, text }) => {
        const file = { mime: 'application/pdf', size: bytes, bytes: null, key, sha256: sha };
        if (replaceId) {
          const { oldKey } = await replaceResumeFile(user.id, replaceId, { fileName, text, file });
          if (oldKey) await store.remove(oldKey).catch((e) => console.error(JSON.stringify({ level: 'warn', msg: 'old blob delete failed', err: String(e?.message ?? e) })));
          return { id: replaceId, created: false };
        }
        return createResume(user.id, { name: b.name || fileName.replace(/\.pdf$/i, '') || 'Resume', fileName, text, file });
      }
    },
    sha256
  );
  return { id: out.id, created: out.created };
});
