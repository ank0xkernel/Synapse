import type { HandleUploadBody } from '@vercel/blob/client';
import { api, ApiError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { driver, issueUploadToken, randomKey } from '@/lib/storage';
import { MAX_PDF_BYTES } from '@/lib/storage-core';

/** Tells the UI which flow to use and, for blob, a fresh pathname the caller may upload to. */
export const GET = api(async () => {
  const user = await requireUser();
  const d = driver();
  return { driver: d, maxBytes: MAX_PDF_BYTES, pathname: d === 'blob' ? randomKey(user.id) : null };
});

/** Token endpoint for direct browser-to-Blob uploads (authenticated, pathname pinned, PDF only, 8 MB). */
export const POST = api(async (req) => {
  const user = await requireUser();
  if (driver() !== 'blob') throw new ApiError(404, 'Direct upload is not enabled');
  const body = (await req.json().catch(() => null)) as HandleUploadBody | null;
  if (!body || typeof body !== 'object' || typeof body.type !== 'string') throw new ApiError(400, 'Invalid upload request');
  return Response.json(await issueUploadToken(user.id, body, req), { headers: { 'Cache-Control': 'no-store' } });
});
