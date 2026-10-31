import 'server-only';
import crypto from 'node:crypto';
import { del, get, issueSignedToken, presignUrl } from '@vercel/blob';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { isOwnKey, newKey, uploadConstraints } from './storage-core';

export type Driver = 'blob' | 'db';

/** Private Vercel Blob when its token is configured, otherwise the resumes.file_bytes column (local dev, tests). */
export const driver = (): Driver => (process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'db');

/** The three Blob operations this app needs. Tests swap in a fake. */
export interface BlobClient {
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
  /** Short-lived URL the browser or desktop can fetch without credentials. */
  signedUrl(key: string, ttlMs: number): Promise<string>;
}

const real: BlobClient = {
  async read(key) {
    const r = await get(key, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return Buffer.from(await new Response(r.stream).arrayBuffer());
  },
  async remove(key) {
    await del(key);
  },
  async signedUrl(key, ttlMs) {
    const validUntil = Date.now() + ttlMs;
    const token = await issueSignedToken({ pathname: key, operations: ['get'], validUntil });
    return (await presignUrl(token, { operation: 'get', pathname: key, access: 'private', validUntil })).presignedUrl;
  }
};

let client: BlobClient = real;
export const blob = () => client;
/** Test hook only. */
export function setBlobClient(c: BlobClient | null) {
  client = c ?? real;
}

export const randomKey = (userId: string) => newKey(userId, crypto.randomUUID());
export const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Token route body. The caller must already be authenticated; the pathname is pinned to
 * resumes/<userId>/<uuid>.pdf, PDF only, 8 MB. Nothing here depends on onUploadCompleted, which
 * does not fire on localhost: finalize is the source of truth.
 */
export function issueUploadToken(userId: string, body: HandleUploadBody, request: Request) {
  return handleUpload({
    body,
    request,
    onBeforeGenerateToken: async (pathname) => ({ ...uploadConstraints(userId, pathname), tokenPayload: JSON.stringify({ userId }) }),
    onUploadCompleted: async () => {}
  });
}

/** Where to send the caller for a stored file: a signed Blob URL valid for two minutes, after the ownership check. */
export const fileUrl = (key: string) => {
  if (!key.startsWith('resumes/')) throw new Error('unexpected storage key');
  return blob().signedUrl(key, 2 * 60 * 1000);
};

export { isOwnKey };
