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
