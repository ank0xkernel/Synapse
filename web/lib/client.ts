export type ApiResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string };

/** JSON call to our own API. Network and server errors both come back as { ok: false, error }. */
export async function call<T = Record<string, unknown>>(method: string, url: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) return { ok: false, error: data?.error || `Request failed (${res.status})` };
    return data;
  } catch {
    return { ok: false, error: 'Network error. Check your connection and try again.' };
  }
}

/** Which upload flow the server wants. `blob`: PDFs go straight to private storage. `db`: multipart through the server. */
export async function uploadDriver(): Promise<'blob' | 'db'> {
  const r = await call<{ driver: 'blob' | 'db' }>('GET', '/api/resumes/upload');
  return r.ok ? r.driver : 'db';
}

/**
 * Direct browser-to-storage PDF upload, then finalize on the server (which validates and parses it).
 * Pass `replaceId` to swap the file of an existing resume.
 */
export async function uploadPdfDirect(
  file: File,
  opts: { replaceId?: string; onProgress?: (pct: number) => void; onStage?: (s: string) => void } = {}
): Promise<ApiResult<{ id: string }>> {
  const cfg = await call<{ pathname: string | null }>('GET', '/api/resumes/upload');
  if (!cfg.ok || !cfg.pathname) return { ok: false, error: cfg.ok ? 'Direct upload is not available' : cfg.error };
  let pathname: string;
  try {
    const { upload } = await import('@vercel/blob/client');
    const res = await upload(cfg.pathname, file, {
      access: 'private',
      contentType: 'application/pdf',
      handleUploadUrl: '/api/resumes/upload',
      onUploadProgress: (e) => opts.onProgress?.(Math.round(e.percentage))
    });
    pathname = res.pathname;
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message ? `Upload failed: ${e.message}` : 'Upload failed. Try again.' };
  }
  opts.onStage?.('Extracting text');
  return call<{ id: string }>('POST', '/api/resumes/finalize', { pathname, fileName: file.name, replaceId: opts.replaceId });
}
