import 'server-only';
import { NextResponse } from 'next/server';
import { z, ZodError, type ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers?: Record<string, string>
  ) {
    super(message);
  }
}

export const notFound = () => new ApiError(404, 'Not found');

export const uuid = z.string().uuid();

/** Route ids that are not UUIDs are simply "not found". */
export function idParam(raw: string): string {
  const r = uuid.safeParse(raw);
  if (!r.success) throw notFound();
  return r.data;
}

/**
 * CSRF defence for cookie-authenticated requests: state-changing methods must carry an Origin
 * header whose host matches this server's host. SameSite=Lax is the second layer.
 */
function assertSameOrigin(req: Request) {
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  let ok = false;
  if (origin && host) {
    try {
      ok = new URL(origin).host === host;
    } catch {
      ok = false;
    }
  }
  if (!ok) throw new ApiError(403, 'Cross-origin request blocked');
}

type Ctx<P> = { params: Promise<P> };

/** Wraps a route handler: same-origin check on mutations, uniform JSON errors, no stack leaks. */
/** `bearer: true` is for routes that ignore cookies entirely (desktop device-token API): there is no ambient credential to forge. */
export function api<P = Record<string, never>>(fn: (req: Request, ctx: Ctx<P>) => Promise<Response | object>, opts: { bearer?: boolean } = {}) {
  return async (req: Request, ctx: Ctx<P>): Promise<Response> => {
    try {
      if (!opts.bearer && !['GET', 'HEAD'].includes(req.method)) assertSameOrigin(req);
      const out = await fn(req, ctx);
      return out instanceof Response ? out : NextResponse.json({ ok: true, ...out });
    } catch (err) {
      if (err instanceof ApiError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: err.status, headers: err.headers });
      }
      if (err instanceof ZodError) {
        const issue = err.issues[0];
        const where = issue?.path.join('.') || 'body';
        return NextResponse.json({ ok: false, error: `Invalid ${where}: ${issue?.message ?? 'bad value'}` }, { status: 400 });
      }
      console.error('[api] unhandled', err instanceof Error ? err.message : err);
      return NextResponse.json({ ok: false, error: 'Something went wrong on the server' }, { status: 500 });
    }
  };
}

export async function readJson<T>(req: Request, schema: ZodType<T>, maxBytes = 512 * 1024): Promise<T> {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > maxBytes) throw new ApiError(413, 'Request body too large');
  const text = await req.text();
  if (text.length > maxBytes) throw new ApiError(413, 'Request body too large');
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, 'Body must be valid JSON');
  }
  return schema.parse(raw);
}
