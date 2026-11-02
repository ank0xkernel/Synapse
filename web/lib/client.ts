export type ApiResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string };

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** JSON call to our own API. Network, timeout, and server errors come back as { ok: false, error }. */
export async function call<T = Record<string, unknown>>(
  method: string,
  url: string,
  body?: unknown,
  opts?: CallOptions
): Promise<ApiResult<T>> {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);

  if (opts?.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      return { ok: false, error: 'Request cancelled.' };
    }
    opts.signal.addEventListener('abort', () => controller.abort(opts.signal?.reason), { once: true });
  }

  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) return { ok: false, error: data?.error || `Request failed (${res.status})` };
    return data;
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('timed out'))) {
      return { ok: false, error: 'Request timed out. Check your connection and try again.' };
    }
    return { ok: false, error: 'Network error. Check your connection and try again.' };
  }
}

/** Which upload flow the server wants. `blob`: PDFs go straight to private storage. `db`: multipart through the server. */
export async function uploadDriver(): Promise<'blob' | 'db'> {
  const r = await call<{ driver: 'blob' | 'db' }>('GET', '/api/resumes/upload', undefined, { timeoutMs: 10_000 });
  return r.ok ? r.driver : 'db';
}

/**
 * Direct browser-to-storage PDF upload, then finalize on the server (which validates and parses it).
 * Pass `replaceId` to swap the file of an existing resume.
 */
export async function uploadPdfDirect(
  file: File,
  opts: {
    replaceId?: string;
    onProgress?: (pct: number) => void;
    onStage?: (s: string) => void;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<ApiResult<{ id: string }>> {
  opts.onStage?.('Connecting');
  opts.onProgress?.(0);
  const cfg = await call<{ pathname: string | null }>('GET', '/api/resumes/upload', undefined, {
    timeoutMs: 15_000,
    signal: opts.signal
  });
  if (!cfg.ok || !cfg.pathname) return { ok: false, error: cfg.ok ? 'Direct upload is not available' : cfg.error };

  let pathname: string;
  try {
    const { upload } = await import('@vercel/blob/client');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Upload timed out')), opts.timeoutMs ?? 60_000);

    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timeout);
        return { ok: false, error: 'Upload cancelled.' };
      }
      opts.signal.addEventListener('abort', () => controller.abort(opts.signal?.reason), { once: true });
    }

    opts.onStage?.('Uploading');
    const res = await upload(cfg.pathname, file, {
      access: 'private',
      contentType: 'application/pdf',
      handleUploadUrl: '/api/resumes/upload',
      abortSignal: controller.signal,
      onUploadProgress: (e) => opts.onProgress?.(Math.round(e.percentage))
    });
    clearTimeout(timeout);
    pathname = res.pathname;
  } catch (e: unknown) {
    if (opts.signal?.aborted || (e instanceof Error && (e.name === 'AbortError' || e.message === 'Upload cancelled.'))) {
      return { ok: false, error: 'Upload cancelled.' };
    }
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('timed out')) {
      return { ok: false, error: 'Upload timed out. Check your connection and try again.' };
    }
    return { ok: false, error: msg ? `Upload failed: ${msg}` : 'Upload failed. Try again.' };
  }

  opts.onProgress?.(100);
  opts.onStage?.('Reading and analysing');
  return call<{ id: string }>(
    'POST',
    '/api/resumes/finalize',
    { pathname, fileName: file.name, replaceId: opts.replaceId },
    { timeoutMs: 60_000, signal: opts.signal }
  );
}
