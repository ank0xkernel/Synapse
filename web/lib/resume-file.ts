import 'server-only';
import { one } from './db';
import { notFound } from './http';

/** Private PDF bytes for one user's resume, or 404. Used by both the cookie and the device-token routes. */
export async function pdfResponse(userId: string, resumeId: string): Promise<Response> {
  const row = await one<{ file_bytes: Buffer | null; mime: string }>('SELECT file_bytes, mime FROM resumes WHERE user_id = $1 AND id = $2', [
    userId,
    resumeId
  ]);
  if (!row || !row.file_bytes || row.mime !== 'application/pdf') throw notFound();
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
